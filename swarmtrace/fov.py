"""
Field-of-View (FOV) — live activity monitor for AI agents.

Patches Playwright, OpenAI/Anthropic streams, requests/httpx,
and the filesystem so every agent action is surfaced in real time
on the SwarmTrace dashboard.  Zero changes to agent code required.

Usage::

    from swarmtrace import init
    init(api_key="...", endpoint="...", fov=True)

    # or explicitly:
    from swarmtrace.fov import patch_all
    patch_all()

What each patch captures
------------------------
* playwright   — every page action (goto/click/fill/…) + continuous background
                 screen stream that never blocks browser actions
* streams      — OpenAI/Anthropic stream tokens as they arrive
* network      — requests / httpx HTTP calls (sync + async) with method, url, status, latency
* filesystem   — file reads/writes in the watched directory (watchdog)

Screen streaming
----------------
Screenshots are captured by a dedicated background thread (default: every 1 s)
rather than inline with browser actions.  This means:
  - Browser actions are never slowed down by screenshot capture
  - The dashboard gets a continuous live feed of the screen
  - Configure interval via SWARMTRACE_SCREEN_INTERVAL env var (seconds, default 1.0)
"""

from __future__ import annotations

import base64
import functools
import json
import logging
import os
import queue
import re
import threading
import time
import uuid
import weakref
from datetime import datetime, timezone

# ── context from tracer ──────────────────────────────────────────────────────
from swarmtrace.tracer import _current_agent, _remote_config
# Redactor — used by tracer.py for span args/output, and now by FOV's
# browser-event path too. See _redact_browser_args below for why FOV
# needs field-aware redaction ON TOP of the pattern-based redact() (a
# raw password like "CorrectHorseBatteryStaple!" matches none of the
# pattern shapes, so pattern-only redaction would let it straight
# through into local SQLite, the remote /api/events endpoint, and
# Supabase).
from swarmtrace.redact import redact as _redact_text

_log = logging.getLogger("swarmtrace.fov")

# ── local event storage ──────────────────────────────────────────────────────
from swarmtrace.storage import _get_conn, _lock as _storage_lock

# ---------------------------------------------------------------------------
# Local SQLite event table — with bounded size (no disk-fill risk)
# ---------------------------------------------------------------------------

_events_table_ready = False
_events_table_lock = threading.Lock()

# FIX #1: cap agent_events table size — was unbounded (would fill disk
# with screenshots in days of browser automation)
EVENT_MAX_ROWS: int  = 5_000
EVENT_PURGE_EVERY: int = 50
_event_write_count: int = 0


def _ensure_events_table() -> None:
    """Create the agent_events table + index on first use (once per process).

    FIX (audit finding #11 — TOCTOU race): this used to be a naive
    check-then-act with no recheck inside the lock and the ready flag set
    AFTER releasing the lock:

        if _events_table_ready: return
        with _storage_lock:
            conn.execute("CREATE TABLE IF NOT EXISTS ...")
            ...
        _events_table_ready = True   # set OUTSIDE the lock

    Every concurrent first caller (a realistic case: several traced
    browser pages registering near-simultaneously at startup) would pass
    the unlocked check before any of them set the flag, then each
    redundantly re-run the CREATE TABLE/INDEX statements once it got the
    lock. The DDL itself is idempotent (IF NOT EXISTS) so this specific
    instance didn't corrupt data, but it's the exact TOCTOU shape that
    HAS caused real bugs elsewhere in this file (see _ensure_fov_worker's
    fork-survival fix) and every other one-time-init flag in this module
    (_fov_worker_started, _screen_streamer_started) already uses a
    dedicated lock with a proper recheck-inside-the-lock — this one was
    the odd one out. Now matches that pattern: dedicated
    _events_table_lock, recheck after acquiring it, flag set while still
    holding it (not after release).

    (Not a fork-survival case like the worker-thread flags — the table's
    existence is a fact about the DB file, which survives fork() fine
    regardless of what this in-memory flag says. No register_at_fork
    hook needed here.)
    """
    global _events_table_ready
    if _events_table_ready:
        return
    with _events_table_lock:
        if _events_table_ready:
            return
        with _storage_lock:
            conn = _get_conn()
            conn.execute("""
                CREATE TABLE IF NOT EXISTS agent_events (
                    id           TEXT PRIMARY KEY,
                    agent_id     TEXT NOT NULL,
                    agent_name   TEXT,
                    event_type   TEXT NOT NULL,
                    status       TEXT NOT NULL DEFAULT 'info',
                    data         TEXT,
                    timestamp    TEXT NOT NULL
                )
            """)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_evts_agent "
                "ON agent_events(agent_id, timestamp DESC)"
            )
            conn.commit()
        _events_table_ready = True


def _purge_old_events(conn) -> None:
    """Delete oldest events beyond EVENT_MAX_ROWS."""
    count = conn.execute("SELECT COUNT(*) FROM agent_events").fetchone()[0]
    if count > EVENT_MAX_ROWS:
        excess = count - EVENT_MAX_ROWS
        conn.execute(
            "DELETE FROM agent_events WHERE id IN "
            "(SELECT id FROM agent_events ORDER BY timestamp ASC LIMIT ?)",
            (excess,),
        )


def _save_event_local(event: dict) -> None:
    global _event_write_count
    _ensure_events_table()
    try:
        with _storage_lock:
            conn = _get_conn()
            conn.execute(
                "INSERT OR REPLACE INTO agent_events "
                "(id, agent_id, agent_name, event_type, status, data, timestamp) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    event["id"],
                    event["agent_id"],
                    event.get("agent_name", ""),
                    event["event_type"],
                    event.get("status", "info"),
                    json.dumps(event.get("data", {})),
                    event["timestamp"],
                ),
            )
            _event_write_count += 1
            # FIX #1 continued: purge on every EVENT_PURGE_EVERY writes
            if _event_write_count % EVENT_PURGE_EVERY == 0:
                _purge_old_events(conn)
            conn.commit()
    except Exception as exc:
        _log.warning("event save warning: %s", exc)


# ---------------------------------------------------------------------------
# Remote event sender  (separate queue → /api/events)
# ---------------------------------------------------------------------------

_FOV_QUEUE_MAX = 500
_FOV_QUEUE: "queue.Queue[dict]" = queue.Queue(maxsize=_FOV_QUEUE_MAX)
_fov_worker_lock = threading.Lock()
_fov_worker_started = False


def _send_event_remote(payload: dict, key: str, base_url: str) -> None:
    try:
        import urllib.request
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{base_url}/api/events",
            data=body,
            headers={"Content-Type": "application/json", "X-API-Key": key},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as exc:
        _log.warning("remote event warning: %s", exc)


def _fov_worker() -> None:
    # FIX #5 (FOV): retry up to 3 times with backoff on remote send failure
    while True:
        payload = _FOV_QUEUE.get()
        key, url = _remote_config()
        if key and url:
            # Normalize URL so both "https://app.vercel.app" and
            # "https://app.vercel.app/api" work (strips trailing /api).
            from swarmtrace.tracer import _normalize_base_url
            base = _normalize_base_url(url)
            for attempt in range(3):
                try:
                    _send_event_remote(payload, key, base)
                    break
                except Exception:
                    if attempt < 2:
                        time.sleep(2 ** attempt)
        _FOV_QUEUE.task_done()


def _ensure_fov_worker() -> None:
    global _fov_worker_started
    if _fov_worker_started:
        return
    with _fov_worker_lock:
        if not _fov_worker_started:
            threading.Thread(
                target=_fov_worker, daemon=True, name="swarmtrace-fov-sender"
            ).start()
            _fov_worker_started = True


def _reset_fov_worker_state_after_fork() -> None:
    """Runs in the CHILD immediately after os.fork(). Same bug as audit
    finding #4 (tracer.py's _worker_started), applied to the FOV sender.

    fork() clones process memory -- including `_fov_worker_started = True`
    -- but not other threads; only the calling thread survives into the
    child. Without this hook, a forked child inherits
    `_fov_worker_started = True` from a parent with a live FOV sender
    thread that does not exist in the child, so `_ensure_fov_worker()`'s
    fast-path check short-circuits forever there -- no sender thread ever
    starts, and every FOV event enqueued via `_enqueue_fov_event()` in
    that process sits in `_FOV_QUEUE` for the process's whole life with
    nothing draining it. Lower severity than #4 (screen-stream / live
    activity events, not trace data -- nothing durable is lost), but the
    same silent-failure shape.

    Fix: reset the flag and swap in a fresh queue so the child spawns its
    own real sender thread on the next enqueue. See
    tracer.py::_reset_worker_state_after_fork for the full writeup.
    """
    global _fov_worker_started, _FOV_QUEUE
    _fov_worker_started = False
    _FOV_QUEUE = queue.Queue(maxsize=_FOV_QUEUE_MAX)


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_fov_worker_state_after_fork)


def _enqueue_fov_event(event: dict) -> None:
    key, url = _remote_config()
    if not (key and url):
        return
    _ensure_fov_worker()
    try:
        _FOV_QUEUE.put_nowait(event)
    except queue.Full:
        # FIX #6 (FOV queue): don't do racy get+put — just log and skip
        _log.error("event queue full — event dropped")


def _save_event(event: dict) -> None:
    """Save event to local SQLite and enqueue for remote ingest."""
    _save_event_local(event)
    _enqueue_fov_event(event)


def _mk_event(event_type: str, status: str, data: dict) -> dict:
    """Build an event dict attributed to the current agent context."""
    agent = _current_agent()
    if agent is None:
        return {}
    agent_id, agent_name = agent
    return {
        "id": uuid.uuid4().hex,
        "agent_id": agent_id,
        "agent_name": agent_name,
        "event_type": event_type,
        "status": status,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Screenshot helpers
# ---------------------------------------------------------------------------

def _resize_jpeg(raw: bytes, max_width: int = 800) -> bytes:
    try:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(raw))
        if img.width > max_width:
            h = int(img.height * max_width / img.width)
            img = img.resize((max_width, h), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=55)
        return buf.getvalue()
    except ImportError:
        return raw


def _to_data_uri(raw: bytes) -> str:
    raw = _resize_jpeg(raw)
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode()


def _screenshot_sync(page) -> str:
    """Capture a screenshot from a Playwright page, thread-safely.

    Handles BOTH sync and async Playwright pages. Sync pages can be called
    from any thread. Async pages (created via async_playwright()) are
    thread-bound — calling page.screenshot() from a different thread
    raises a greenlet/context error. For async pages we extract the
    page's event loop (page._impl_obj._loop) and submit the screenshot
    coroutine back to it via asyncio.run_coroutine_threadsafe().

    Returns "" for transient errors (timeout, network hiccup) so the
    streamer retries next tick. RE-RAISES for permanent errors (page/
    browser closed) so the streamer's except block deregisters the page
    and stops spamming. Without the re-raise, a closed page would log
    the same error every SCREEN_INTERVAL forever.
    """
    try:
        # Detect async Playwright page: it has _impl_obj with an event loop.
        impl = getattr(page, "_impl_obj", None)
        loop = getattr(impl, "_loop", None)
        if loop is not None and not loop.is_closed():
            import asyncio
            fut = asyncio.run_coroutine_threadsafe(
                page.screenshot(type="jpeg", quality=50), loop
            )
            raw = fut.result(timeout=10)
        else:
            raw = page.screenshot(type="jpeg", quality=50)
        return _to_data_uri(raw)
    except Exception as exc:
        msg = str(exc).lower()
        # Permanent errors — page/browser is gone. Re-raise so the streamer
        # deregisters this page and stops retrying. Without this, a closed
        # browser would spam this error every SCREEN_INTERVAL forever.
        if any(s in msg for s in (
            "target page, context or browser has been closed",
            "target closed",
            "browser has been closed",
            "page has been closed",
            "context has been closed",
            "connection closed",
        )):
            raise
        # Transient error (timeout, etc.) — log and return "" so the
        # streamer retries next tick without deregistering.
        _log.warning("screenshot failed: %s", str(exc)[:120])
        return ""


async def _screenshot_async(page) -> str:
    try:
        raw = await page.screenshot(type="jpeg", quality=50)
        return _to_data_uri(raw)
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Background screen streamer
#
# Instead of taking screenshots inline (which blocked every browser action
# for 50-300ms), a daemon thread polls each registered page at a fixed
# interval and emits "screen_tick" events.  Browser actions are never slowed.
#
# Pages register themselves on first use and are auto-removed when closed.
# Interval is configurable via SWARMTRACE_SCREEN_INTERVAL (default 1.0 s).
# ---------------------------------------------------------------------------

SCREEN_INTERVAL: float = float(os.environ.get("SWARMTRACE_SCREEN_INTERVAL", "1.0"))

# registry: page_id → (weakref to page, agent_id, agent_name)
_screen_registry: dict[int, tuple] = {}
_screen_registry_lock = threading.Lock()
_screen_streamer_lock = threading.Lock()
_screen_streamer_started = False


def _register_page(page, agent_id: str, agent_name: str) -> None:
    """Register a Playwright sync page for background screen streaming."""
    pid = id(page)
    with _screen_registry_lock:
        _screen_registry[pid] = (weakref.ref(page), agent_id, agent_name)
    _ensure_screen_streamer()


def _unregister_page(page) -> None:
    pid = id(page)
    with _screen_registry_lock:
        _screen_registry.pop(pid, None)


def _screen_streamer_loop() -> None:
    """Background thread: capture a screenshot from every registered page each tick."""
    while True:
        time.sleep(SCREEN_INTERVAL)
        with _screen_registry_lock:
            items = list(_screen_registry.items())

        dead = []
        for pid, (page_ref, agent_id, agent_name) in items:
            page = page_ref()
            if page is None:
                dead.append(pid)
                continue
            try:
                # Check if page is still open before screenshotting
                if getattr(page, "is_closed", lambda: False)():
                    dead.append(pid)
                    continue
                shot = _screenshot_sync(page)
                if shot:
                    _save_event({
                        "id": uuid.uuid4().hex,
                        "agent_id": agent_id,
                        "agent_name": agent_name,
                        "event_type": "screen_tick",
                        "status": "info",
                        "data": {
                            "screenshot": shot,
                            "url": _redact_url(getattr(page, "url", "")),
                        },
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
            except Exception:
                dead.append(pid)

        if dead:
            with _screen_registry_lock:
                for pid in dead:
                    _screen_registry.pop(pid, None)


def _ensure_screen_streamer() -> None:
    global _screen_streamer_started
    if _screen_streamer_started:
        return
    with _screen_streamer_lock:
        if not _screen_streamer_started:
            threading.Thread(
                target=_screen_streamer_loop,
                daemon=True,
                name="swarmtrace-screen-stream",
            ).start()
            _screen_streamer_started = True


# ---------------------------------------------------------------------------
# 1. Playwright patch
# ---------------------------------------------------------------------------

_PLAYWRIGHT_PATCHED = False

_PAGE_METHODS = [
    "goto", "click", "fill", "type", "press",
    "select_option", "check", "uncheck", "tap",
    "dblclick", "hover", "drag_and_drop",
]


# Methods whose second positional arg is the VALUE being entered/selected
# (the first arg is the selector). For these, we ALWAYS redact the value
# and record only metadata (length) — not just when the selector matches
# a keyword. Reviewer P1 fix: generic selectors like 'input:nth-of-type(2)'
# or '#field-2' don't contain password/token/secret keywords, so keyword-
# based detection leaks the value. The only safe default is to redact
# every fill/type value.
_VALUE_METHODS = {"fill", "type", "press", "select_option"}

# Methods whose first positional arg is a URL. We apply _redact_url() to
# strip query strings and fragments (which carry session tokens, OAuth
# codes, API keys, and reset tokens).
_URL_METHODS = {"goto"}

# Selectors that name a sensitive input. We match case-insensitively
# anywhere in the selector string (covers #password, [name="password"],
# input[name="user_token"], #apiKey, .auth-secret, etc.). The alternation
# is deliberately broad — false positives (redacting a non-sensitive
# field) are far cheaper than false negatives (leaking a credential).
_SENSITIVE_SELECTOR_RE = re.compile(
    r"(?i)(password|passwd|pwd|token|secret|api[_-]?key|apikey|"
    r"auth(?:orization)?|cookie|session|credential|access[_-]?key|"
    r"private[_-]?key|client[_-]?secret|otp|totp|mfa|2fa|"
    r"ssn|social[_-]?security|credit[_-]?card|card[_-]?number|cvv|cvc|"
    r"security[_-]?answer|security[_-]?question|pin|"
    r"recovery[_-]?code|backup[_-]?code)"
)

_REDACTED = "[REDACTED]"


def _redact_url(url: str) -> str:
    """Strip query strings and fragments from a captured URL.

    URLs are recorded on every browser 'done' event and on every
    screen_tick. Query strings routinely contain session tokens
    (?session=...), OAuth codes (?code=...), API keys (?key=...),
    and reset tokens (?token=...). Fragments can carry JWTs and
    access tokens in SPA auth flows. We keep origin + path only.
    """
    if not url or not isinstance(url, str):
        return url or ""
    # Cut at the first '?' or '#' — whichever comes first.
    cut = len(url)
    for ch in ("?", "#"):
        idx = url.find(ch)
        if idx != -1 and idx < cut:
            cut = idx
    return url[:cut]


def _redact_browser_args(method: str, args: tuple) -> list:
    """Redact positional args captured for a Playwright method call.

    Three layers:

    1. **Value-method redaction** (the high-value layer): for fill/type/
       press/select_option, the VALUE arg (position 1) is ALWAYS replaced
       with [REDACTED(len=N)] — regardless of the selector. Reviewer P1
       fix: generic selectors like 'input:nth-of-type(2)' or '#field-2'
       don't contain password/token/secret keywords, so keyword-based
       detection leaked the value. The only safe default is to redact
       every fill/type value and record only the length for debugging.

    2. **URL redaction**: for goto, the URL arg (position 0) is passed
       through _redact_url() to strip query strings and fragments that
       carry session tokens, OAuth codes, API keys, and reset tokens.

    3. **Pattern-based** (defense-in-depth): run every remaining string
       arg through redact() to catch API keys / JWTs / emails / card
       numbers in any position.

    Args are truncated to 200 chars after redaction, matching the
    pre-existing behavior.
    """
    out = []
    for i, a in enumerate(args):
        # Layer 1: always redact the VALUE arg of fill/type/press/select_option.
        if method in _VALUE_METHODS and i == 1:
            val_len = len(str(a))
            out.append(f"[REDACTED(len={val_len})]")
            continue
        # Layer 2: redact URLs in goto's first arg.
        if method in _URL_METHODS and i == 0 and isinstance(a, str):
            out.append(_redact_url(a)[:200])
            continue
        # Layer 3: pattern-based defense-in-depth on every remaining arg.
        s = str(a)
        s = _redact_text(s) or s
        out.append(s[:200])
    return out


def _wrap_sync_method(name: str, original):
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):
        agent = _current_agent()
        if agent is None:
            return original(self, *args, **kwargs)
        aid, aname = agent
        # Register this page for background screen streaming (idempotent)
        _register_page(self, aid, aname)
        # Redact args ONCE here, reuse for both started/done events.
        # _redact_browser_args field-aware-redacts sensitive fill/type/etc.
        # values and pattern-redacts every arg as defense-in-depth.
        redacted_args = _redact_browser_args(name, args)
        ev = _mk_event("browser", "started", {
            "method": name,
            "args": redacted_args,
        })
        if ev:
            _save_event(ev)
        try:
            result = original(self, *args, **kwargs)
            # No inline screenshot — background streamer handles it every SCREEN_INTERVAL s
            ev2 = _mk_event("browser", "done", {
                "method": name,
                "args": redacted_args,
                "url": _redact_url(getattr(self, "url", "")),
            })
            if ev2:
                _save_event(ev2)
            return result
        except Exception as exc:
            ev3 = _mk_event("browser", "error", {"method": name, "error": _redact_text(str(exc)) or ""})
            if ev3:
                _save_event(ev3)
            raise
    wrapper._swarmtrace_patched = True
    return wrapper


def _wrap_async_method(name: str, original):
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):
        agent = _current_agent()
        if agent is None:
            return await original(self, *args, **kwargs)
        aid, aname = agent
        # Register page for background streaming (sync registry — safe from async)
        _register_page(self, aid, aname)
        redacted_args = _redact_browser_args(name, args)
        ev = _mk_event("browser", "started", {"method": name, "args": redacted_args})
        if ev:
            _save_event(ev)
        try:
            result = await original(self, *args, **kwargs)
            ev2 = _mk_event("browser", "done", {
                "method": name,
                "args": redacted_args,
                "url": _redact_url(getattr(self, "url", "")),
            })
            if ev2:
                _save_event(ev2)
            return result
        except Exception as exc:
            ev3 = _mk_event("browser", "error", {"method": name, "error": _redact_text(str(exc)) or ""})
            if ev3:
                _save_event(ev3)
            raise
    wrapper._swarmtrace_patched = True
    return wrapper


def patch_playwright() -> bool:
    global _PLAYWRIGHT_PATCHED
    if _PLAYWRIGHT_PATCHED:
        return True
    patched = False
    try:
        from playwright.sync_api import Page as SP
        for m in _PAGE_METHODS:
            orig = getattr(SP, m, None)
            if orig and not getattr(orig, "_swarmtrace_patched", False):
                setattr(SP, m, _wrap_sync_method(m, orig))
        patched = True
    except ImportError:
        pass
    try:
        from playwright.async_api import Page as AP
        for m in _PAGE_METHODS:
            orig = getattr(AP, m, None)
            if orig and not getattr(orig, "_swarmtrace_patched", False):
                setattr(AP, m, _wrap_async_method(m, orig))
        patched = True
    except ImportError:
        pass
    _PLAYWRIGHT_PATCHED = True
    return patched


# ---------------------------------------------------------------------------
# 2. LLM stream patch  (OpenAI + Anthropic)
# ---------------------------------------------------------------------------

_STREAMS_PATCHED = False

# FIX #11: use a rolling accumulator instead of a growing list
# was: self._buf: list[str] = [] + "".join(self._buf)[-500:] on every token
# O(n²) for long responses — now O(1) per token
_MAX_ACCUM = 500


class _StreamWrapper:
    """Wraps an OpenAI sync stream, firing token events per chunk."""
    def __init__(self, stream, agent_id: str, agent_name: str):
        self._stream = stream
        self._agent_id = agent_id
        self._agent_name = agent_name
        self._accum: str = ""   # FIX #11: rolling window, not growing list

    def __iter__(self):
        for chunk in self._stream:
            token = ""
            try:
                token = chunk.choices[0].delta.content or ""
            except Exception:
                pass
            if token:
                self._accum = (self._accum + token)[-_MAX_ACCUM:]
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": self._agent_id,
                    "agent_name": self._agent_name,
                    "event_type": "llm_token",
                    "status": "streaming",
                    "data": {
                        # Redact tokens/accumulated for PII (API keys,
                        # emails, JWTs may appear in LLM output).
                        "token": _redact_text(token) or "",
                        "accumulated": _redact_text(self._accum) or "",
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            yield chunk

    def __enter__(self):
        if hasattr(self._stream, "__enter__"):
            self._stream.__enter__()
        return self

    def __exit__(self, *a):
        if hasattr(self._stream, "__exit__"):
            return self._stream.__exit__(*a)

    def __getattr__(self, name):
        return getattr(self._stream, name)


class _AsyncStreamWrapper:
    """Wraps an OpenAI async stream."""
    def __init__(self, stream, agent_id: str, agent_name: str):
        self._stream = stream
        self._agent_id = agent_id
        self._agent_name = agent_name
        self._accum: str = ""   # FIX #11: rolling window

    def __aiter__(self):
        return self._aiter()

    async def _aiter(self):
        async for chunk in self._stream:
            token = ""
            try:
                token = chunk.choices[0].delta.content or ""
            except Exception:
                pass
            if token:
                self._accum = (self._accum + token)[-_MAX_ACCUM:]
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": self._agent_id,
                    "agent_name": self._agent_name,
                    "event_type": "llm_token",
                    "status": "streaming",
                    "data": {
                        # Redact tokens/accumulated for PII.
                        "token": _redact_text(token) or "",
                        "accumulated": _redact_text(self._accum) or "",
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            yield chunk

    async def __aenter__(self):
        if hasattr(self._stream, "__aenter__"):
            await self._stream.__aenter__()
        return self

    async def __aexit__(self, *a):
        if hasattr(self._stream, "__aexit__"):
            return await self._stream.__aexit__(*a)

    def __getattr__(self, name):
        return getattr(self._stream, name)


def patch_streams() -> bool:
    global _STREAMS_PATCHED
    if _STREAMS_PATCHED:
        return True
    patched = False
    # OpenAI
    try:
        import openai.resources.chat.completions as _cc
        _orig = _cc.Completions.create

        @functools.wraps(_orig)
        def _patched_create(self, *args, **kwargs):
            result = _orig(self, *args, **kwargs)
            agent = _current_agent()
            if agent and kwargs.get("stream", False):
                aid, aname = agent
                return _StreamWrapper(result, aid, aname)
            return result

        _cc.Completions.create = _patched_create
        patched = True
    except Exception:
        pass

    # OpenAI async
    try:
        import openai.resources.chat.completions as _cc
        _aorig = _cc.AsyncCompletions.create

        @functools.wraps(_aorig)
        async def _async_patched(self, *args, **kwargs):
            result = await _aorig(self, *args, **kwargs)
            agent = _current_agent()
            if agent and kwargs.get("stream", False):
                aid, aname = agent
                return _AsyncStreamWrapper(result, aid, aname)
            return result

        _cc.AsyncCompletions.create = _async_patched
        patched = True
    except Exception:
        pass

    _STREAMS_PATCHED = True
    return patched


# ---------------------------------------------------------------------------
# 3. Network patch  (requests + httpx sync + httpx async)
# ---------------------------------------------------------------------------

_NETWORK_PATCHED = False

# Skip these to avoid double-counting SDK-wrapped LLM calls
_SKIP_HOSTS = {
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.groq.com",
}


def _skip_url(url: str) -> bool:
    return any(h in url for h in _SKIP_HOSTS)


def patch_network() -> bool:
    global _NETWORK_PATCHED
    if _NETWORK_PATCHED:
        return True
    patched = False

    # requests
    try:
        import requests
        _orig_req = requests.Session.request

        @functools.wraps(_orig_req)
        def _patched_req(self, method, url, **kwargs):
            agent = _current_agent()
            if agent is None or _skip_url(str(url)):
                return _orig_req(self, method, url, **kwargs)
            aid, aname = agent
            ts = datetime.now(timezone.utc).isoformat()
            t0 = time.perf_counter()
            try:
                resp = _orig_req(self, method, url, **kwargs)
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "done",
                    "data": {
                        "method": method.upper(), "url": _redact_url(str(url))[:300],
                        "status_code": resp.status_code,
                        "latency_sec": round(time.perf_counter() - t0, 3),
                    },
                    "timestamp": ts,
                })
                return resp
            except Exception as exc:
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "error",
                    "data": {"method": method.upper(), "url": _redact_url(str(url))[:300], "error": _redact_text(str(exc)) or ""},
                    "timestamp": ts,
                })
                raise

        requests.Session.request = _patched_req
        patched = True
    except ImportError:
        pass

    # httpx sync
    try:
        import httpx
        _orig_send = httpx.Client.send

        @functools.wraps(_orig_send)
        def _patched_send(self, request, **kwargs):
            agent = _current_agent()
            url = str(request.url)
            if agent is None or _skip_url(url):
                return _orig_send(self, request, **kwargs)
            aid, aname = agent
            ts = datetime.now(timezone.utc).isoformat()
            t0 = time.perf_counter()
            try:
                resp = _orig_send(self, request, **kwargs)
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "done",
                    "data": {
                        "method": request.method, "url": _redact_url(url)[:300],
                        "status_code": resp.status_code,
                        "latency_sec": round(time.perf_counter() - t0, 3),
                    },
                    "timestamp": ts,
                })
                return resp
            except Exception as exc:
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "error",
                    "data": {"method": request.method, "url": _redact_url(url)[:300], "error": _redact_text(str(exc)) or ""},
                    "timestamp": ts,
                })
                raise

        httpx.Client.send = _patched_send
        patched = True
    except ImportError:
        pass

    # FIX #12: httpx AsyncClient was NOT patched — async HTTP calls invisible
    try:
        import httpx
        _orig_async_send = httpx.AsyncClient.send

        @functools.wraps(_orig_async_send)
        async def _patched_async_send(self, request, **kwargs):
            agent = _current_agent()
            url = str(request.url)
            if agent is None or _skip_url(url):
                return await _orig_async_send(self, request, **kwargs)
            aid, aname = agent
            ts = datetime.now(timezone.utc).isoformat()
            t0 = time.perf_counter()
            try:
                resp = await _orig_async_send(self, request, **kwargs)
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "done",
                    "data": {
                        "method": request.method, "url": _redact_url(url)[:300],
                        "status_code": resp.status_code,
                        "latency_sec": round(time.perf_counter() - t0, 3),
                    },
                    "timestamp": ts,
                })
                return resp
            except Exception as exc:
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "error",
                    "data": {"method": request.method, "url": _redact_url(url)[:300], "error": _redact_text(str(exc)) or ""},
                    "timestamp": ts,
                })
                raise

        httpx.AsyncClient.send = _patched_async_send
        patched = True
    except ImportError:
        pass

    _NETWORK_PATCHED = True
    return patched


# ---------------------------------------------------------------------------
# 4. Filesystem watcher (watchdog)
# ---------------------------------------------------------------------------

_FS_PATCHED = False


def patch_filesystem(watch_dir: str = ".") -> bool:
    global _FS_PATCHED
    if _FS_PATCHED:
        return True
    try:
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler

        class _Handler(FileSystemEventHandler):
            def _emit(self, action: str, path: str):
                if any(x in path for x in (".swarmtrace", "__pycache__", ".git", ".pyc")):
                    return
                agent = _current_agent()
                if agent is None:
                    return
                aid, aname = agent
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "file", "status": "info",
                    "data": {"action": action, "path": path[-200:]},
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

            def on_modified(self, ev):
                if not ev.is_directory:
                    self._emit("modified", ev.src_path)

            def on_created(self, ev):
                if not ev.is_directory:
                    self._emit("created", ev.src_path)

        obs = Observer()
        obs.schedule(_Handler(), path=os.path.abspath(watch_dir), recursive=True)
        obs.daemon = True
        obs.start()
        _FS_PATCHED = True
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------------------
# patch_all — one call to activate everything
# ---------------------------------------------------------------------------

def patch_all(watch_dir: str = ".") -> dict:
    """
    Activate all FOV patches.

    Returns which patches are active::

        {"playwright": True, "streams": True, "network": True, "filesystem": False}

    ``filesystem=False`` means watchdog is not installed — all other patches
    work without it.  Install with ``pip install watchdog``.
    """
    results = {
        "playwright":  patch_playwright(),
        "streams":     patch_streams(),
        "network":     patch_network(),
        "filesystem":  patch_filesystem(watch_dir),
    }
    active = [k for k, v in results.items() if v]
    _log.info("patches active: %s", ', '.join(active) or 'none')
    return results


def get_events(agent_id: str, limit: int = 100) -> list:
    """Return recent FOV events for a given agent_id."""
    _ensure_events_table()
    try:
        # FIX #10: don't mutate conn.row_factory — use cursor description instead
        # was: conn.row_factory = sqlite3.Row ... conn.row_factory = None
        # that races with any concurrent reader on the shared connection
        with _storage_lock:
            conn = _get_conn()
            cur = conn.execute(
                "SELECT * FROM agent_events WHERE agent_id=? "
                "ORDER BY timestamp DESC LIMIT ?",
                (agent_id, limit),
            )
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
    except Exception:
        return []
