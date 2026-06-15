"""
@observe decorator — records every sync/async call to the traces DB.

Usage::

    from tracely import observe

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
of the Agents page entirely rather than appearing as a phantom agent. This
means wrapping an LLM or tool call in ``@observe`` for visibility never turns
it into a fake "agent" on the dashboard::

    @observe                    # kind="agent" — this run IS an agent
    def orchestrator(q):
        research = researcher(q)   # also kind="agent" — its own agent
        return summarize(research)

    @observe(kind="tool")       # rolls up into the calling agent's stats
    def search_web(q):
        ...

    @observe(kind="llm")        # rolls up into the calling agent's stats
    def call_llm(prompt):
        ...
"""

import asyncio
import contextvars
import functools
import json
import os
import queue
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Optional, Tuple
from urllib.request import Request, urlopen

from tracely.storage import save_trace
from tracely.pricing import calculate_cost

# ---------------------------------------------------------------------------
# Remote ingest configuration (lazy — env vars are read at call time)
# ---------------------------------------------------------------------------

_api_key: Optional[str] = None
_endpoint: Optional[str] = None


def init(api_key: Optional[str] = None, endpoint: Optional[str] = None) -> None:
    """Explicitly configure remote ingest (takes precedence over env vars)."""
    global _api_key, _endpoint
    if api_key is not None:
        _api_key = api_key
    if endpoint is not None:
        _endpoint = endpoint


def _remote_config() -> tuple[str, str]:
    key = _api_key if _api_key is not None else os.environ.get("SWARMTRACE_API_KEY", "")
    url = _endpoint if _endpoint is not None else os.environ.get("SWARMTRACE_ENDPOINT", "")
    return key, url.rstrip("/")


# ---------------------------------------------------------------------------
# Background sender — a single daemon worker draining a bounded queue,
# instead of one thread per trace (which does not scale under hot loops).
# ---------------------------------------------------------------------------

_QUEUE_MAX = 1000
_send_queue: "queue.Queue[dict]" = queue.Queue(maxsize=_QUEUE_MAX)
_worker_lock = threading.Lock()
_worker_started = False


def _send_remote(payload: dict, key: str, url: str) -> None:
    try:
        body = json.dumps(payload).encode()
        req = Request(
            f"{url}/ingest",
            data=body,
            headers={"Content-Type": "application/json", "X-API-Key": key},
            method="POST",
        )
        urlopen(req, timeout=5)
    except Exception as exc:
        print(f"[swarmtrace] remote ingest warning: {exc}", file=sys.stderr)


def _worker() -> None:
    while True:
        payload = _send_queue.get()
        key, url = _remote_config()
        if key and url:
            _send_remote(payload, key, url)
        _send_queue.task_done()


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
        # Drop the oldest trace to make room — never block the traced code.
        try:
            _send_queue.get_nowait()
            _send_queue.put_nowait(payload)
        except Exception:
            pass
        print("[swarmtrace] ingest queue full — dropped oldest trace", file=sys.stderr)


# Thread-safe & async-safe parent tracking
_parent_ctx: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "parent_ctx", default=None
)


def _current_parent() -> Optional[str]:
    return _parent_ctx.get()


# Thread-safe & async-safe agent tracking — (agent_id, agent_name) of the
# nearest enclosing kind="agent" span. Used to attribute tool/llm/function
# spans to the agent that's actually running them, regardless of whether the
# parent_id chain stays intact end-to-end.
_agent_ctx: contextvars.ContextVar[Optional[Tuple[str, str]]] = contextvars.ContextVar(
    "agent_ctx", default=None
)


def _current_agent() -> Optional[Tuple[str, str]]:
    """Return ``(agent_id, agent_name)`` of the nearest enclosing agent span, if any."""
    return _agent_ctx.get()


# ---------------------------------------------------------------------------
# Shared record-and-save logic (keeps sync + async wrappers DRY)
# ---------------------------------------------------------------------------

_VALID_KINDS = {"agent", "tool", "llm", "function"}


def _build_trace_id() -> str:
    # Full uuid4 hex (32 chars). Short 8-char IDs are collision-prone at scale.
    return uuid.uuid4().hex


def _extract_token_info(result) -> tuple[int, int, float]:
    """Pull token/cost fields off the result.

    If the LLM library already provides cost_usd, use it directly.
    Otherwise calculate from the live LiteLLM pricing table using
    the model name on the result object.
    """
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
    # Capture up to the first two positional args + any kwargs for the record.
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
    """Flush, but never let a storage/network failure mask the user's exception."""
    try:
        _flush(*flush_args)
    except Exception as exc:
        print(f"[swarmtrace] trace flush warning: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def observe(func=None, *, kind: str = "agent"):
    """
    Decorator that records every call (sync or async) to the traces DB.

    Can be used bare (``@observe``, which defaults to ``kind="agent"``) or
    with an explicit kind::

        @observe(kind="tool")
        def search_web(q): ...

    See the module docstring for the full ``kind`` taxonomy and how
    ``agent_id``/``agent_name`` attribution works.

    Propagates parent-child relationships automatically via contextvars,
    so nested ``@observe`` calls are linked in the tree, and attributes
    every non-agent span to its nearest enclosing agent span.
    """
    if func is None:
        return lambda f: observe(f, kind=kind)

    if kind not in _VALID_KINDS:
        raise ValueError(
            f"observe(kind={kind!r}) is invalid — kind must be one of "
            f"{sorted(_VALID_KINDS)}"
        )

    if asyncio.iscoroutinefunction(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            trace_id = _build_trace_id()
            parent_id = _current_parent()
            enclosing_agent = _current_agent()
            timestamp = datetime.now(timezone.utc).isoformat()
            parent_token = _parent_ctx.set(trace_id)

            if kind == "agent":
                agent_id, agent_name = trace_id, func.__name__
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
                output = str(result)[:4000]
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
                    kind, agent_id, agent_name,
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

        if kind == "agent":
            agent_id, agent_name = trace_id, func.__name__
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
            output = str(result)[:4000]
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
                kind, agent_id, agent_name,
            )
            _parent_ctx.reset(parent_token)
            if agent_token is not None:
                _agent_ctx.reset(agent_token)

    return sync_wrapper
