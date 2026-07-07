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
import hashlib
import json
import os
import queue
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from datetime import datetime, timezone
from typing import Optional, Tuple
from urllib.request import Request, urlopen

from swarmtrace.storage import save_trace
from swarmtrace.pricing import calculate_cost

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
        # fov=False is the default, and on its own prints nothing — a user on
        # Kaggle/Colab/serverless/MCP has no way to tell "not traced" apart
        # from "quietly working". One line makes the default explicit and
        # points at the upgrade path without requiring it.
        print(
            "[swarmtrace] tracing: @observe spans"
            + (" + auto-instrumented LLM calls" if auto_instrument else "")
            + " | http/stream/filesystem/browser capture is off — "
              "pass init(fov=True) (pip install swarmtrace[fov] for browser screenshots)",
            file=sys.stderr,
        )
    if alerts:
        from swarmtrace.alerts import start as _alerts_start
        _alerts_start(interval_seconds=alert_interval_seconds)


def _remote_config() -> tuple[str, str]:
    key = _api_key if _api_key is not None else os.environ.get("SWARMTRACE_API_KEY", "")
    url = _endpoint if _endpoint is not None else os.environ.get("SWARMTRACE_ENDPOINT", "")
    return key, _normalize_base_url(url)


def _normalize_base_url(url: str) -> str:
    """Normalize the endpoint URL so it works whether the user set it with
    or without a trailing /api.

    Users set SWARMTRACE_ENDPOINT in different ways:
        https://app.vercel.app
        https://app.vercel.app/
        https://app.vercel.app/api
        https://app.vercel.app/api/

    All four should work. We strip trailing slashes and a trailing /api,
    then callers append the full path (/api/ingest, /api/events, etc.).
    """
    s = url.rstrip("/")
    if s.endswith("/api"):
        s = s[:-4]
    return s


# ---------------------------------------------------------------------------
# Background sender — daemon worker draining a bounded queue.
# FIX #5: added retry with exponential backoff (3 attempts) so brief
# endpoint hiccups don't silently drop traces.
# ---------------------------------------------------------------------------

_QUEUE_MAX = 1000
_send_queue: "queue.Queue[dict]" = queue.Queue(maxsize=_QUEUE_MAX)
_worker_lock = threading.Lock()
_worker_started = False


def _send_remote(payload: dict, key: str, url: str) -> None:
    body = json.dumps(payload).encode()
    req = Request(
        f"{url}/api/ingest",
        data=body,
        headers={"Content-Type": "application/json", "X-API-Key": key},
        method="POST",
    )
    urlopen(req, timeout=5)


def _worker() -> None:
    """Background sender thread.

    Error boundary: any unexpected exception (e.g. a bug in _remote_config,
    a corrupt payload, or an OS-level error) is caught at the outer loop so
    the thread never dies silently.  task_done() is called in a finally block
    so the queue's join() never deadlocks even when an item raises.
    """
    _RESTART_DELAY = 1.0   # seconds to wait before restarting after a crash

    while True:
        payload: Optional[dict] = None
        try:
            payload = _send_queue.get()
            key, url = _remote_config()
            if key and url:
                # Retry with exponential backoff (3 attempts)
                for attempt in range(3):
                    try:
                        _send_remote(payload, key, url)
                        break
                    except Exception as exc:
                        if attempt < 2:
                            time.sleep(2 ** attempt)   # 1 s then 2 s
                        else:
                            print(
                                f"[swarmtrace] remote ingest failed after 3 attempts: {exc}",
                                file=sys.stderr,
                            )
        except Exception as exc:
            # Outer error boundary — log and keep the thread alive.
            print(f"[swarmtrace] worker error (thread continues): {exc}", file=sys.stderr)
        finally:
            # Always mark the item done so queue.join() never deadlocks.
            if payload is not None:
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
        print("[swarmtrace] ingest queue full — trace dropped", file=sys.stderr)


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

    Repeated invocations of the same top-level ``@observe`` function (the
    auto-resolved "agent" case) used to get a fresh random ``agent_id`` per
    call, which made the dashboard's Agents page show one card per run
    instead of one persistent agent whose task count climbs over time.

    Deriving the id from a SHA-256 of ``"{module}.{qualname}"`` (or an
    explicit ``name``) makes repeat runs collapse into a single agent
    identity. The digest is 32 hex chars — same length as ``uuid4().hex``
    — so it drops into the existing TEXT column without schema changes.

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
) -> None:
    args_repr = str(args[:2])
    if kwargs:
        args_repr = f"{args_repr} kwargs={list(kwargs.keys())}"
    save_trace(
        trace_id, parent_id, func_name,
        args_repr, output, latency, error,
        timestamp, in_tok, out_tok, cost,
        kind, agent_id, agent_name,
    )

    _enqueue_remote({
        "id": trace_id, "parent_id": parent_id, "function": func_name,
        "args": args_repr, "output": output or "", "latency_sec": latency,
        "error": error, "timestamp": timestamp,
        "input_tokens": in_tok, "output_tokens": out_tok, "cost_usd": cost,
        "kind": kind, "agent_id": agent_id, "agent_name": agent_name,
    })


def _safe_flush(*flush_args) -> None:
    try:
        _flush(*flush_args)
    except Exception as exc:
        print(f"[swarmtrace] trace flush warning: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def observe(func=None, *, kind: str = "auto", name: Optional[str] = None):
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
        return lambda f: observe(f, kind=kind, name=name)

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
                    resolved_kind, agent_id, agent_name,
                )
                _parent_ctx.reset(parent_token)
                if agent_token is not None:
                    _agent_ctx.reset(agent_token)

        return async_wrapper

    @functools.wraps(func)
    def sync_wrapper(*args, **kwargs):
        trace_id = _build_trace_id()
        parent_id = _current_parent()
        enclosing_agent = _current_agent()
        timestamp = datetime.now(timezone.utc).isoformat()
        parent_token = _parent_ctx.set(trace_id)

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
                resolved_kind, agent_id, agent_name,
            )
            _parent_ctx.reset(parent_token)
            if agent_token is not None:
                _agent_ctx.reset(agent_token)

    return sync_wrapper
