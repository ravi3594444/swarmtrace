"""
@observe decorator — records every sync/async call to the traces DB.

Usage::

    from swarmtrace import observe

    @observe
    def my_agent(prompt: str) -> str:
        ...

    @observe
    async def my_async_agent(prompt: str) -> str:
        ...

Remote ingest is enabled by setting SWARMTRACE_API_KEY and SWARMTRACE_ENDPOINT.
The environment is read lazily (at call time), so values set after import
(e.g. by ``load_dotenv()``) are picked up. Alternatively call :func:`init`.

Span kinds
----------
Every traced call has a ``kind``:

- ``"agent"``    (default) — the call itself IS an agent / autonomous run.
  Shows up as its own entry on the dashboard's Agents page.
- ``"tool"``     — a tool invocation made *by* an agent.
- ``"llm"``      — a raw LLM call made *by* an agent.
- ``"function"`` — any other traced helper that isn't its own agent.

Only ``kind="agent"`` spans are surfaced as agents. Everything else is
attributed (via ``agent_id`` / ``agent_name``) to the nearest enclosing
``kind="agent"`` span — or to itself if there isn't one, which keeps it out
of the Agents page entirely rather than appearing as a phantom agent.
"""

import asyncio
import contextvars
import functools
import gzip
import hashlib
import json
import logging
import os
import queue
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, List, Optional, Tuple
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from swarmtrace.storage import save_trace, mark_synced
from swarmtrace.pricing import calculate_cost
from swarmtrace.redact import redact

_log = logging.getLogger("swarmtrace")

# ---------------------------------------------------------------------------
# Remote ingest configuration (lazy — env vars are read at call time)
# ---------------------------------------------------------------------------

_api_key: Optional[str] = None
_endpoint: Optional[str] = None


def init(
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
    auto_instrument: bool = True,
    fov: bool = False,
    fov_watch_dir: str = ".",
    alerts: bool = False,
    alert_interval_seconds: int = 60,
) -> None:
    global _api_key, _endpoint
    if api_key is not None:
        _api_key = api_key
    if endpoint is not None:
        _endpoint = endpoint
    if auto_instrument:
        from swarmtrace.auto_instrument import patch_all
        patch_all()
    if fov:
        from swarmtrace.fov import patch_all as fov_patch_all
        fov_patch_all(watch_dir=fov_watch_dir)
    else:
        # fov=False is the default, and on its own emits nothing — a user on
        # Kaggle/Colab/serverless/MCP has no way to tell "not traced" apart
        # from "quietly working". One info-level log makes the default
        # explicit and points at the upgrade path without requiring it.
        # The host app's logging config decides whether this surfaces; we
        # don't attach handlers ourselves.
        _log.info(
            "tracing: @observe spans%s | http/stream/filesystem/browser capture is off — "
            "pass init(fov=True) (pip install swarmtrace[fov] for browser screenshots)",
            " + auto-instrumented LLM calls" if auto_instrument else "",
        )
    if alerts:
        from swarmtrace.alerts import start as _alerts_start
        _alerts_start(interval_seconds=alert_interval_seconds)


def _remote_config() -> tuple[str, str]:
    key = _api_key if _api_key is not None else os.environ.get("SWARMTRACE_API_KEY", "")
    raw_url = _endpoint if _endpoint is not None else os.environ.get("SWARMTRACE_ENDPOINT", "")

    # Scheme enforcement (audit finding #5): refuse to send the API key
    # over plaintext HTTP to non-localhost hosts. Returns "" for the URL
    # when invalid, which causes the worker to skip sending — matching
    # the "no endpoint configured" path. The warning is logged every call
    # (the worker only calls this every ~2s on batch flush, so it's not
    # log-spam); the user fixes their config to silence it.
    ok, reason = _validate_endpoint_scheme(raw_url)
    if not ok:
        _log.warning("SWARMTRACE_ENDPOINT insecure — refusing to send traces: %s", reason)
        return key, ""
    return key, _normalize_base_url(raw_url)


def _validate_endpoint_scheme(url: str) -> tuple[bool, str]:
    """Check whether *url* is safe to send the API key to.

    Returns ``(ok, reason)``. ``ok=True`` means safe (or empty — no
    endpoint configured). ``ok=False`` means the URL would leak the API
    key; ``reason`` is a human-readable explanation for the log warning.

    Rules:
      - Empty URL → ok (means no endpoint configured; worker will skip).
      - ``https://`` → ok (any host).
      - ``http://`` → ok ONLY for ``localhost``, ``127.0.0.1``, ``::1``
        (local dev / testing).
      - ``http://`` to anything else → rejected.
      - Any other scheme (``ftp://``, ``file://``, etc.) → rejected.
      - No scheme at all → rejected (ambiguous — could be either).

    Audit finding #5: previously ``_normalize_base_url`` accepted any
    string, so ``SWARMTRACE_ENDPOINT=http://example.com`` would silently
    send the API key over plaintext HTTP with zero warning.
    """
    if not url:
        return True, ""

    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    hostname = (parsed.hostname or "").lower()

    if scheme == "https":
        return True, ""

    if scheme == "http":
        # Allow localhost variants for local dev / testing.
        # Note: this is intentionally narrow — only the canonical localhost
        # names. RFC1918 IPs (192.168.x.x, 10.x.x.x, etc.) are NOT allowed
        # because they're often used for internal services that may not be
        # as trusted as a dev loopback. Users who need that can set up HTTPS
        # locally (mkcert, caddy, etc.).
        if hostname in ("localhost", "127.0.0.1", "::1"):
            return True, ""
        return False, (
            f"http:// to non-localhost host '{hostname}' would send the "
            f"API key over plaintext HTTP. Use https://, or set "
            f"SWARMTRACE_ENDPOINT=http://localhost:... for local dev."
        )

    return False, (
        f"unsupported scheme '{scheme or '(none)'}://' — only https:// "
        f"(any host) and http:// (localhost only) are allowed."
    )


def _normalize_base_url(url: str) -> str:
    """Normalize the endpoint URL so it works whether the user set it with
    or without a trailing /api.

    Users set SWARMTRACE_ENDPOINT in different ways:
        https://app.vercel.app
        https://app.vercel.app/
        https://app.vercel.app/api
        https://app.vercel.app/api/

    All four should work. We strip surrounding whitespace and trailing
    slashes and a trailing /api, then callers append the full path
    (/api/ingest, /api/events, etc.).

    Note: scheme validation happens in _validate_endpoint_scheme (called
    from _remote_config), NOT here. This function is purely about path
    normalization — it doesn't second-guess whether the URL is safe.

    Edge cases handled (audit finding #9):
      - Repeated slashes before the suffix, e.g. ``.../api//`` or
        ``...//api/`` (a plausible copy-paste typo) — previously left a
        stray trailing slash after stripping ``/api`` (only the OUTER
        slashes were stripped by the single ``rstrip("/")``, so a doubled
        slash immediately before ``api`` survived the ``[:-4]`` cut). Now
        re-strips trailing slashes after removing the suffix.
      - Case: ``.../API`` (or ``/Api``, etc.) — previously not recognized
        as the suffix at all (plain ``str.endswith`` is case-sensitive),
        so the stray ``/API`` segment survived and calling code would
        build a doubled, wrong path like ``.../API/api/ingest``. Matched
        case-insensitively now, while the RETAINED portion of the URL
        keeps its original casing (only the recognized ``/api`` suffix
        itself is stripped, not lowercased-and-compared-then-reinserted).
      - Leading/trailing whitespace (e.g. a trailing newline or space from
        an env var set via a shell heredoc or `.env` file) is now trimmed.

    Known remaining limitation, NOT handled (documented rather than
    fixed — a query string or fragment in the endpoint URL is not a
    realistic configuration for this env var, so it isn't worth the
    complexity of full URL parsing here): ``https://host/api?x=1`` will
    NOT have ``/api`` recognized as the suffix (the string doesn't end in
    ``/api``), so the ``?x=1`` survives into the "normalized" base and
    breaks subsequent path concatenation. Don't put a query string or
    fragment in SWARMTRACE_ENDPOINT.
    """
    s = url.strip().rstrip("/")
    if s[-4:].casefold() == "/api":
        s = s[:-4].rstrip("/")
    return s


# ---------------------------------------------------------------------------
# Background sender — daemon worker draining a bounded queue.
# FIX #5: added retry with exponential backoff (3 attempts) so brief
# endpoint hiccups don't silently drop traces.
#
# Task 4 (batching + gzip): the worker no longer sends one POST per trace.
# It drains the queue into a batch of up to _BATCH_MAX_ITEMS traces, OR
# flushes after _BATCH_FLUSH_TIMEOUT seconds since the first item landed
# (whichever comes first). The batch is serialized as {"traces": [...]},
# gzip-compressed, and sent in a single POST. This cuts HTTP overhead by
# ~20x for bursty workloads and shrinks wire bytes ~5-10x for compressible
# trace payloads (args/output are often repetitive text).
# ---------------------------------------------------------------------------

_QUEUE_MAX = 1000
_BATCH_MAX_ITEMS = 20
_BATCH_FLUSH_TIMEOUT = 2.0   # seconds — flush even if batch isn't full
_send_queue: "queue.Queue[dict]" = queue.Queue(maxsize=_QUEUE_MAX)
_worker_lock = threading.Lock()
_worker_started = False


def _send_remote(payload: dict, key: str, url: str) -> None:
    """Send a SINGLE trace payload (legacy single-object shape).

    Used by the resync CLI, which replays one row at a time. The live
    background worker uses _send_batch_remote instead — see _worker.
    """
    body = json.dumps(payload).encode()
    req = Request(
        f"{url}/api/ingest",
        data=body,
        headers={"Content-Type": "application/json", "X-API-Key": key},
        method="POST",
    )
    urlopen(req, timeout=5)


def _send_batch_remote(payloads: List[dict], key: str, url: str) -> None:
    """Send a BATCH of traces as one gzip'd POST.

    Body shape: ``{"traces": [...]}`` (the new batch shape accepted by
    /api/ingest since swarmtrace 0.6.0). gzip-compressed — trace payloads
    are highly compressible (args/output are repetitive text), so this
    typically shrinks wire bytes 5-10x.

    Raises on any HTTP error (the caller retries). The endpoint returns
    204 on success (no body) — we don't read it.
    """
    body = json.dumps({"traces": payloads}).encode()
    compressed = gzip.compress(body)
    req = Request(
        f"{url}/api/ingest",
        data=compressed,
        headers={
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            "X-API-Key": key,
        },
        method="POST",
    )
    urlopen(req, timeout=10)  # batches take longer than single traces


def _drain_batch(max_items: int, timeout: float) -> List[dict]:
    """Drain up to ``max_items`` payloads from the queue.

    Blocks until at least one item is available (so the worker doesn't
    spin), then drains any immediately-available items up to the cap.
    The ``timeout`` only applies to the FIRST item — once we have one,
    we drain non-blocking. This gives us the "20 items or 2 seconds,
    whichever first" behavior: the first item starts the clock, and we
    flush as soon as either the batch fills or there are no more items
    immediately available.
    """
    batch: List[dict] = []
    # Block up to `timeout` for the first item.
    try:
        first = _send_queue.get(timeout=timeout)
        batch.append(first)
    except queue.Empty:
        return batch
    # Drain any immediately-available items up to the cap.
    while len(batch) < max_items:
        try:
            batch.append(_send_queue.get_nowait())
        except queue.Empty:
            break
    return batch


def _worker() -> None:
    """Background sender thread (batched + gzip'd).

    Error boundary: any unexpected exception (e.g. a bug in _remote_config,
    a corrupt payload, or an OS-level error) is caught at the outer loop so
    the thread never dies silently. task_done() is called per item in a
    finally block so the queue's join() never deadlocks.

    Sync flag: on a confirmed-successful batch send, EVERY trace in the
    batch is marked synced=1. On failure (3 retries exhausted), all rows
    in the batch stay synced=0 so the resync CLI can pick them up later.
    Batch-level atomicity matches the backend's behavior — the backend
    validates the whole batch and 400s if any trace is bad, so partial
    success isn't possible.
    """
    while True:
        batch: List[dict] = []
        try:
            batch = _drain_batch(_BATCH_MAX_ITEMS, _BATCH_FLUSH_TIMEOUT)
            if not batch:
                continue   # timed out waiting — loop and try again
            key, url = _remote_config()
            if key and url:
                sent_ok = False
                # Retry with exponential backoff (3 attempts)
                for attempt in range(3):
                    try:
                        _send_batch_remote(batch, key, url)
                        sent_ok = True
                        break
                    except Exception as exc:
                        if attempt < 2:
                            time.sleep(2 ** attempt)   # 1 s then 2 s
                        else:
                            _log.error("remote ingest failed after 3 attempts: %s", exc)
                # Mark every trace in the batch synced on confirmed success.
                # Failed batches stay synced=0 as a unit — resync replays them.
                if sent_ok:
                    for payload in batch:
                        mark_synced(payload.get("id", ""))
        except Exception as exc:
            # Outer error boundary — log and keep the thread alive.
            _log.error("worker error (thread continues): %s", exc)
        finally:
            # Always mark every drained item done so queue.join() never
            # deadlocks — even if the batch send raised.
            for _ in batch:
                try:
                    _send_queue.task_done()
                except Exception:
                    pass


def _ensure_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    with _worker_lock:
        if not _worker_started:
            threading.Thread(target=_worker, daemon=True, name="swarmtrace-sender").start()
            _worker_started = True


def _reset_worker_state_after_fork() -> None:
    """Runs in the CHILD immediately after os.fork(). Audit finding #4.

    fork() clones process memory -- including the `_worker_started = True`
    flag -- but NOT other threads; only the calling thread survives into
    the child. Without this hook, a child process (gunicorn/uWSGI preload
    workers, Celery prefork pool, os.fork() directly, etc.) inherits
    `_worker_started = True` from the parent even though its background
    sender thread does not exist there. `_ensure_worker()`'s fast-path
    check (`if _worker_started: return`) then short-circuits forever in
    that child -- no sender thread is ever started, so every trace
    enqueued via `_enqueue_remote` in that process sits in `_send_queue`
    for the lifetime of the worker with nothing ever draining it. No
    exception is raised anywhere; it just silently never syncs. This is
    permanent for that process, unlike a transient `Thread.start()`
    failure (which leaves `_worker_started` False and self-heals on the
    next call) -- hence "real" data loss, not just a retryable blip.

    Traces are NOT lost outright: `save_trace()` (SQLite) runs before
    `_enqueue_remote()` in `_flush()`, so every trace is still on disk
    with synced=0 and `swarmtrace resync` can ship it later -- but remote
    ingest silently stops working in every forked child until this fires.

    Fix: reset the flag so the next `_enqueue_remote()` call in the child
    spawns a real sender thread of its own. Also replace `_send_queue`
    with a fresh one -- any payloads already sitting in the inherited
    queue belonged to a sender thread that only exists in the parent, and
    replaying into a Queue whose internal locks may be in an inconsistent
    post-fork state is riskier than just starting clean (those payloads
    are already durable in SQLite, so nothing is lost by dropping them
    from the in-memory queue).

    Same gotcha, same fix pattern used by other telemetry SDKs with
    background sender threads (e.g. Sentry, PostHog) for this exact
    reason. POSIX-only -- os.fork() doesn't exist on Windows, guarded by
    the hasattr check at registration below.
    """
    global _worker_started, _send_queue
    _worker_started = False
    _send_queue = queue.Queue(maxsize=_QUEUE_MAX)


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_worker_state_after_fork)


def _enqueue_remote(payload: dict) -> None:
    key, url = _remote_config()
    if not (key and url):
        return
    _ensure_worker()
    try:
        _send_queue.put_nowait(payload)
    except queue.Full:
        # FIX #6: don't do racy get_nowait()+put_nowait() — just log and drop.
        # The old approach had a race where two threads both popped an item then
        # both tried to push, losing 2 traces instead of 1.
        _log.error("ingest queue full — trace dropped")


# ---------------------------------------------------------------------------
# Resync — replay unsynced traces to the remote endpoint.
# Used by the ``swarmtrace resync`` CLI. Reads rows where synced=0 from the
# local SQLite DB and POSTs each one to /api/ingest, marking synced=1 on
# success. Synchronous (no background queue) so the CLI can report progress
# and exit code. Returns (attempted, succeeded, failed) counts.
# ---------------------------------------------------------------------------

def _row_to_payload(row: dict) -> dict:
    """Convert a traces table row (dict, keyed by column name — see
    storage.py:TraceRow) into the /api/ingest payload shape."""
    payload = {
        "id": row["id"], "parent_id": row["parent_id"], "function": row["function"],
        "args": row["args"] or "", "output": row["output"] or "",
        "latency_sec": row["latency_sec"],
        "error": row["error"], "timestamp": row["timestamp"],
        "input_tokens": row["input_tokens"] or 0,
        "output_tokens": row["output_tokens"] or 0,
        "cost_usd": row["cost_usd"] or 0.0,
        "kind": row["kind"], "agent_id": row["agent_id"], "agent_name": row["agent_name"],
    }
    if row.get("session_id") is not None:
        payload["session_id"] = row["session_id"]
    return payload


def resync(batch_size: int = 100, retries: int = 3) -> tuple[int, int, int]:
    """Re-send unsynced traces to the remote endpoint.

    Reads up to ``batch_size`` unsynced rows from the local DB and POSTs
    each to ``/api/ingest``. On success, marks the row ``synced=1``. On
    failure (after ``retries`` attempts with backoff), leaves the row
    ``synced=0`` so the next resync run retries it.

    Returns ``(attempted, succeeded, failed)``. If the remote endpoint
    isn't configured (no API key / endpoint), returns ``(0, 0, 0)`` — the
    caller (CLI) reports this as "remote not configured" rather than
    treating it as an error.
    """
    from swarmtrace.storage import get_unsynced_traces

    key, url = _remote_config()
    if not (key and url):
        return (0, 0, 0)

    rows = get_unsynced_traces(limit=batch_size)
    if not rows:
        return (0, 0, 0)

    attempted = len(rows)
    succeeded = 0
    failed = 0
    for row in rows:
        payload = _row_to_payload(row)
        trace_id = payload["id"]
        sent_ok = False
        for attempt in range(retries):
            try:
                _send_remote(payload, key, url)
                sent_ok = True
                break
            except Exception as exc:
                if attempt < retries - 1:
                    time.sleep(2 ** attempt)
                else:
                    _log.error("resync: failed to send trace %s after %d attempts: %s",
                               trace_id, retries, exc)
        if sent_ok:
            mark_synced(trace_id, 1)
            succeeded += 1
        else:
            failed += 1
    return (attempted, succeeded, failed)


# Thread-safe & async-safe parent tracking
_parent_ctx: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "parent_ctx", default=None
)


def _current_parent() -> Optional[str]:
    return _parent_ctx.get()


_agent_ctx: contextvars.ContextVar[Optional[Tuple[str, str]]] = contextvars.ContextVar(
    "agent_ctx", default=None
)


def _current_agent() -> Optional[Tuple[str, str]]:
    """Return ``(agent_id, agent_name)`` of the nearest enclosing agent span, if any."""
    return _agent_ctx.get()


# Session/conversation grouping — the id of the enclosing conversation, if any.
# Set either by ``@observe(session_id=...)`` or the ``session()`` context
# manager, and inherited by every nested traced call so a whole multi-turn
# conversation stitches together as one thread on the dashboard.
_session_ctx: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "session_ctx", default=None
)


def _current_session() -> Optional[str]:
    return _session_ctx.get()


@contextmanager
def session(session_id: Optional[str] = None) -> Iterator[str]:
    """Group every traced call made inside the block into one conversation.

    Usage::

        import swarmtrace

        with swarmtrace.session("conversation-42") as sid:
            chat_agent("hi")          # turn 1
            chat_agent("and then?")   # turn 2 — same thread

    If ``session_id`` is omitted a random one is generated and yielded, so you
    can capture it (e.g. to correlate with your own chat/thread id). Nesting is
    supported: an inner ``session()`` temporarily overrides the outer one and
    the previous value is restored on exit.
    """
    sid = session_id or uuid.uuid4().hex
    token = _session_ctx.set(sid)
    try:
        yield sid
    finally:
        _session_ctx.reset(token)


# ---------------------------------------------------------------------------
# Shared record-and-save logic
# ---------------------------------------------------------------------------

_VALID_KINDS  = {"agent", "tool", "llm", "function"}
_KIND_CHOICES = _VALID_KINDS | {"auto"}

# FIX #3: use a ThreadPoolExecutor for _safe_str instead of spawning a new
# thread on every single call.  At 100+ traced calls/sec, per-call thread
# creation was creating thousands of OS threads per second.
_str_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="st-str")


def _resolve_kind(kind: str, enclosing_agent: Optional[Tuple[str, str]]) -> str:
    if kind != "auto":
        return kind
    return "agent" if enclosing_agent is None else "function"


def _safe_str(obj, max_len: int = 4000) -> str:
    """Convert *obj* to string safely using a thread-pool (not a new thread per call)."""
    if obj is None:
        return ""
    try:
        fut = _str_pool.submit(lambda: str(obj)[:max_len])
        return fut.result(timeout=0.1)
    except FuturesTimeout:
        return f"<{type(obj).__name__} (stringify timed out)>"
    except Exception:
        return f"<{type(obj).__name__} (stringify failed)>"


def _build_trace_id() -> str:
    return uuid.uuid4().hex


def _stable_agent_id(func, name: Optional[str]) -> str:
    """Deterministic agent_id for a bare ``@observe`` entrypoint.

    See docs/SDK_DASHBOARD_CONTRACT.md for the full SDK<->dashboard
    agent_id/kind contract this is one half of.

    Repeated invocations of the same top-level ``@observe`` function (the
    auto-resolved "agent" case) used to get a fresh random ``agent_id`` per
    call, which made the dashboard's Agents page show one card per run
    instead of one persistent agent whose task count climbs over time.

    Deriving the id from a SHA-256 of ``"{module}.{qualname}"`` (or an
    explicit ``name``) makes repeat runs collapse into a single agent
    identity. The digest is 64 hex chars (SHA-256 is 256 bits = 32 bytes
    = 64 hex chars — longer than ``uuid4().hex``'s 32, but it still
    drops into the existing TEXT column without schema changes).

    Note: this ONLY applies to bare ``@observe`` (auto-resolved). Explicit
    ``@observe(kind="agent")`` keeps a fresh ``trace_id`` so that swarm
    sub-agents (orchestrator/researcher/summarizer within one run) stay
    distinct, per ``test_nested_agents_each_get_their_own_agent_id``.

    Lambda disambiguation: all lambdas share the qualname ``<lambda>``
    (or ``outer.<locals>.<lambda>`` when nested), so two distinct lambdas
    in the same scope would hash to the SAME agent_id and silently
    collapse into one dashboard card — exactly the bug the stable-id
    fix was meant to prevent. We disambiguate by appending the source
    line number (``co_firstlineno``) to the hash source ONLY when the
    qualname contains ``<lambda>``. The line number is stable across
    calls of the same lambda (so repeat runs still aggregate) but
    differs between distinct lambdas (so they don't collide).

    Named functions are NOT affected — refactoring (moving a function
    to a different line) must not break aggregation. Two lambdas
    defined on the same source line still collide; that's a rare
    pathological case and the user can disambiguate with ``name=``.

    Closures from the same factory (``make_bot.<locals>.bot``) are also
    NOT affected — they share the same source line by definition, so
    line-number disambiguation can't help. They keep the documented
    limitation (collision unless ``name=`` is used).
    """
    if name:
        src = name
    else:
        src = f"{func.__module__}.{func.__qualname__}"
        # Lambda disambiguation — see docstring above.
        qualname = getattr(func, "__qualname__", "") or ""
        if "<lambda>" in qualname:
            code = getattr(func, "__code__", None)
            lineno = getattr(code, "co_firstlineno", "?")
            src = f"{src}@{lineno}"
    return hashlib.sha256(src.encode("utf-8")).hexdigest()


def _extract_token_info(result) -> tuple[int, int, float]:
    if result is None:
        return 0, 0, 0.0

    in_tok  = int(getattr(result, "input_tokens",  0) or 0)
    out_tok = int(getattr(result, "output_tokens", 0) or 0)
    cost    = float(getattr(result, "cost_usd", 0) or 0)

    if cost == 0.0 and (in_tok > 0 or out_tok > 0):
        model = (
            getattr(result, "model", None)
            or getattr(result, "model_id", None)
            or getattr(result, "model_name", None)
            or ""
        )
        if model:
            cost = calculate_cost(str(model), in_tok, out_tok)

    return in_tok, out_tok, cost


def _flush(
    trace_id: str,
    parent_id: Optional[str],
    func_name: str,
    args,
    kwargs,
    output: Optional[str],
    latency: float,
    error: Optional[str],
    timestamp: str,
    in_tok: int,
    out_tok: int,
    cost: float,
    kind: str,
    agent_id: str,
    agent_name: str,
    session_id: Optional[str] = None,
) -> None:
    # Cap args_repr at the same 4000-char limit _safe_str applies to output.
    # Without this, a single large argument (big string, dataframe repr, etc.)
    # produces an unbounded args field that:
    #   1. Bloats the local SQLite DB (the row never syncs — the server's
    #      MAX_BODY_BYTES = 64KB rejects the whole batch of up to 20 traces
    #      it gets bundled into, and resync() retries the oversized row
    #      forever, never marking it synced=1 — silent permanent leak).
    #   2. Asymmetry with output: output is capped via _safe_str, args wasn't,
    #      so the dashboard showed truncated returns but full argument dumps.
    # Audit finding #3.
    args_repr = _safe_str(args[:2])
    if kwargs:
        args_repr = f"{args_repr} kwargs={list(kwargs.keys())}"
    # PII redaction — single call site, applied once to args/output/error
    # so the local SQLite DB and the remote ingest endpoint see the SAME
    # scrubbed payload.  Redacting here (not in save_trace / _enqueue_remote)
    # means the two never disagree about what was stored.  See redact.py
    # for the categories scrubbed and the deliberate non-PII pass-through
    # (16-digit trace IDs, UUIDs, SHA-256 hashes are NOT touched).
    args_repr = redact(args_repr)
    output = redact(output)
    error = redact(error)
    save_trace(
        id_=trace_id, parent_id=parent_id, function=func_name,
        args=args_repr, output=output, latency_sec=latency, error=error,
        timestamp=timestamp, input_tokens=in_tok, output_tokens=out_tok,
        cost_usd=cost, kind=kind, agent_id=agent_id, agent_name=agent_name,
        session_id=session_id,
    )

    payload = {
        "id": trace_id, "parent_id": parent_id, "function": func_name,
        "args": args_repr, "output": output or "", "latency_sec": latency,
        "error": error, "timestamp": timestamp,
        "input_tokens": in_tok, "output_tokens": out_tok, "cost_usd": cost,
        "kind": kind, "agent_id": agent_id, "agent_name": agent_name,
    }
    if session_id is not None:
        payload["session_id"] = session_id
    _enqueue_remote(payload)


def _safe_flush(*flush_args) -> None:
    try:
        _flush(*flush_args)
    except Exception as exc:
        _log.warning("trace flush warning: %s", exc)


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def observe(func=None, *, kind: str = "auto", name: Optional[str] = None,
            session_id: Optional[str] = None):
    """
    Decorator that records every call (sync or async) to the traces DB.

    Bare ``@observe`` defaults to ``kind="auto"``:
    - If no agent is currently running → this call becomes ``"agent"``.
    - If called from inside another ``@observe``'d function → rolls up as ``"function"``.

    ``name`` (optional, only meaningful for the auto-resolved "agent" case):
    overrides the displayed ``agent_name`` AND seeds the stable ``agent_id``
    hash instead of ``func.__qualname__``. Useful when the same function
    represents different agents based on runtime config, or when you want a
    human-readable id source. Ignored for explicit ``kind="agent"`` (swarm
    sub-agents keep fresh per-call ids, but ``name`` still overrides the
    displayed ``agent_name`` for readability).
    """
    if func is None:
        return lambda f: observe(f, kind=kind, name=name, session_id=session_id)

    if kind not in _KIND_CHOICES:
        raise ValueError(
            f"observe(kind={kind!r}) is invalid — kind must be one of "
            f"{sorted(_KIND_CHOICES)}"
        )

    if asyncio.iscoroutinefunction(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            trace_id = _build_trace_id()
            parent_id = _current_parent()
            enclosing_agent = _current_agent()
            timestamp = datetime.now(timezone.utc).isoformat()
            parent_token = _parent_ctx.set(trace_id)

            if session_id is not None:
                session_token = _session_ctx.set(session_id)
                resolved_session = session_id
            else:
                session_token = None
                resolved_session = _current_session()

            resolved_kind = _resolve_kind(kind, enclosing_agent)

            if resolved_kind == "agent":
                if kind == "auto":
                    # Bare @observe at top level → stable identity so repeat
                    # runs aggregate into one dashboard agent card.
                    agent_id = _stable_agent_id(func, name)
                    agent_name = name if name else func.__name__
                else:
                    # Explicit kind="agent" → fresh id per call so swarm
                    # sub-agents (orchestrator/researcher/summarizer within
                    # one run) stay distinct.
                    agent_id = trace_id
                    agent_name = name if name else func.__name__
                agent_token = _agent_ctx.set((agent_id, agent_name))
            else:
                agent_id, agent_name = enclosing_agent or (trace_id, func.__name__)
                agent_token = None

            start = time.perf_counter()
            output: Optional[str] = None
            error: Optional[str] = None
            in_tok = out_tok = 0
            cost = 0.0

            try:
                result = await func(*args, **kwargs)
                output = _safe_str(result)
                in_tok, out_tok, cost = _extract_token_info(result)
                return result
            except Exception as exc:
                error = str(exc)
                raise
            finally:
                _safe_flush(
                    trace_id, parent_id, func.__name__,
                    args, kwargs, output,
                    round(time.perf_counter() - start, 3),
                    error, timestamp, in_tok, out_tok, cost,
                    resolved_kind, agent_id, agent_name, resolved_session,
                )
                _parent_ctx.reset(parent_token)
                if agent_token is not None:
                    _agent_ctx.reset(agent_token)
                if session_token is not None:
                    _session_ctx.reset(session_token)

        return async_wrapper

    @functools.wraps(func)
    def sync_wrapper(*args, **kwargs):
        trace_id = _build_trace_id()
        parent_id = _current_parent()
        enclosing_agent = _current_agent()
        timestamp = datetime.now(timezone.utc).isoformat()
        parent_token = _parent_ctx.set(trace_id)

        if session_id is not None:
            session_token = _session_ctx.set(session_id)
            resolved_session = session_id
        else:
            session_token = None
            resolved_session = _current_session()

        resolved_kind = _resolve_kind(kind, enclosing_agent)

        if resolved_kind == "agent":
            if kind == "auto":
                # Bare @observe at top level → stable identity so repeat
                # runs aggregate into one dashboard agent card.
                agent_id = _stable_agent_id(func, name)
                agent_name = name if name else func.__name__
            else:
                # Explicit kind="agent" → fresh id per call so swarm
                # sub-agents (orchestrator/researcher/summarizer within
                # one run) stay distinct.
                agent_id = trace_id
                agent_name = name if name else func.__name__
            agent_token = _agent_ctx.set((agent_id, agent_name))
        else:
            agent_id, agent_name = enclosing_agent or (trace_id, func.__name__)
            agent_token = None

        start = time.perf_counter()
        output: Optional[str] = None
        error: Optional[str] = None
        in_tok = out_tok = 0
        cost = 0.0

        try:
            result = func(*args, **kwargs)
            output = _safe_str(result)
            in_tok, out_tok, cost = _extract_token_info(result)
            return result
        except Exception as exc:
            error = str(exc)
            raise
        finally:
            _safe_flush(
                trace_id, parent_id, func.__name__,
                args, kwargs, output,
                round(time.perf_counter() - start, 3),
                error, timestamp, in_tok, out_tok, cost,
                resolved_kind, agent_id, agent_name, resolved_session,
            )
            _parent_ctx.reset(parent_token)
            if agent_token is not None:
                _agent_ctx.reset(agent_token)
            if session_token is not None:
                _session_ctx.reset(session_token)

    return sync_wrapper
