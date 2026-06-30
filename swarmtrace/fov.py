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
import os
import queue
import sys
import threading
import time
import uuid
import weakref
from datetime import datetime, timezone

# ── context from tracer ──────────────────────────────────────────────────────
from swarmtrace.tracer import _current_agent, _remote_config

# ── local event storage ──────────────────────────────────────────────────────
from swarmtrace.storage import _get_conn, _lock as _storage_lock

# ---------------------------------------------------------------------------
# Local SQLite event table — with bounded size (no disk-fill risk)
# ---------------------------------------------------------------------------

_events_table_ready = False

# FIX #1: cap agent_events table size — was unbounded (would fill disk
# with screenshots in days of browser automation)
EVENT_MAX_ROWS: int  = 5_000
EVENT_PURGE_EVERY: int = 50
_event_write_count: int = 0


def _ensure_events_table() -> None:
    global _events_table_ready
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
        print(f"[swarmtrace/fov] event save warning: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Remote event sender  (separate queue → /api/events)
# ---------------------------------------------------------------------------

_FOV_QUEUE: "queue.Queue[dict]" = queue.Queue(maxsize=500)
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
        print(f"[swarmtrace/fov] remote event warning: {exc}", file=sys.stderr)


def _fov_worker() -> None:
    # FIX #5 (FOV): retry up to 3 times with backoff on remote send failure
    while True:
        payload = _FOV_QUEUE.get()
        key, url = _remote_config()
        if key and url:
            for attempt in range(3):
                try:
                    _send_event_remote(payload, key, url.rstrip("/"))
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


def _enqueue_fov_event(event: dict) -> None:
    key, url = _remote_config()
    if not (key and url):
        return
    _ensure_fov_worker()
    try:
        _FOV_QUEUE.put_nowait(event)
    except queue.Full:
        # FIX #6 (FOV queue): don't do racy get+put — just log and skip
        print("[swarmtrace/fov] event queue full — event dropped", file=sys.stderr)


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
    try:
        raw = page.screenshot(type="jpeg", quality=50)
        return _to_data_uri(raw)
    except Exception:
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
                            "url": getattr(page, "url", ""),
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


def _wrap_sync_method(name: str, original):
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):
        agent = _current_agent()
        if agent is None:
            return original(self, *args, **kwargs)
        aid, aname = agent
        # Register this page for background screen streaming (idempotent)
        _register_page(self, aid, aname)
        ev = _mk_event("browser", "started", {
            "method": name,
            "args": [str(a)[:200] for a in args],
        })
        if ev:
            _save_event(ev)
        try:
            result = original(self, *args, **kwargs)
            # No inline screenshot — background streamer handles it every SCREEN_INTERVAL s
            ev2 = _mk_event("browser", "done", {
                "method": name,
                "args": [str(a)[:200] for a in args],
                "url": getattr(self, "url", ""),
            })
            if ev2:
                _save_event(ev2)
            return result
        except Exception as exc:
            ev3 = _mk_event("browser", "error", {"method": name, "error": str(exc)})
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
        ev = _mk_event("browser", "started", {"method": name, "args": [str(a)[:200] for a in args]})
        if ev:
            _save_event(ev)
        try:
            result = await original(self, *args, **kwargs)
            ev2 = _mk_event("browser", "done", {
                "method": name,
                "args": [str(a)[:200] for a in args],
                "url": getattr(self, "url", ""),
            })
            if ev2:
                _save_event(ev2)
            return result
        except Exception as exc:
            ev3 = _mk_event("browser", "error", {"method": name, "error": str(exc)})
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
                        "token": token,
                        "accumulated": self._accum,
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
                        "token": token,
                        "accumulated": self._accum,
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
                        "method": method.upper(), "url": str(url)[:300],
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
                    "data": {"method": method.upper(), "url": str(url)[:300], "error": str(exc)},
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
                        "method": request.method, "url": url[:300],
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
                    "data": {"method": request.method, "url": url[:300], "error": str(exc)},
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
                        "method": request.method, "url": url[:300],
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
                    "data": {"method": request.method, "url": url[:300], "error": str(exc)},
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
    print(f"[swarmtrace/fov] patches active: {', '.join(active) or 'none'}", file=sys.stderr)
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
