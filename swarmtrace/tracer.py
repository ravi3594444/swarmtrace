"""
@observe decorator, records every sync/async call to the traces DB.

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

- ``"agent"``    (default), the call itself IS an agent / autonomous run.
  Shows up as its own entry on the dashboard's Agents page.
- ``"tool"``    , a tool invocation made *by* an agent.
- ``"llm"``     , a raw LLM call made *by* an agent.
- ``"function"``, any other traced helper that isn't its own agent.

Only ``kind="agent"`` spans are surfaced as agents. Everything else is
attributed (via ``agent_id`` / ``agent_name``) to the nearest enclosing
``kind="agent"`` span, or to itself if there isn't one, which keeps it out
of the Agents page entirely rather than appearing as a phantom agent.
"""

import functools
import hashlib
import inspect
import logging
import os
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from contextlib import contextmanager
from datetime import datetime, timezone

from swarmtrace.adapters.http_transport import HttpTransport
from swarmtrace.adapters.sqlite_repository import SqliteRepository
from swarmtrace.config import (
    configure_remote,
    normalize_base_url,
    resolve_remote_config,
    validate_endpoint_scheme,
)
from swarmtrace.delivery.sender import Sender
from swarmtrace.pricing import calculate_cost
from swarmtrace.redact import redact
from swarmtrace.runtime import Runtime, get_runtime, set_runtime
from swarmtrace.span_model import SpanRecord
from swarmtrace.trace_context import (
    _agent_ctx,
    _parent_ctx,
    _session_ctx,
    _trace_ctx,
)
from swarmtrace.trace_context import (
    current_agent as _current_agent,
)
from swarmtrace.trace_context import (
    current_parent as _current_parent,
)
from swarmtrace.trace_context import (
    current_session as _current_session,
)
from swarmtrace.trace_context import (
    current_trace as _current_trace,
)

_log = logging.getLogger("swarmtrace")

# Remote ingest configuration (lazy, env vars are read at call time)
# ``swarmtrace.config`` owns the actual config/validation rules. These private
# aliases stay in tracer.py for backwards compatibility with older tests and
# integrations that monkeypatch ``swarmtrace.tracer._api_key`` / ``_endpoint``.

_api_key: str | None = None
_endpoint: str | None = None


def init(
    api_key: str | None = None,
    endpoint: str | None = None,
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
    configure_remote(api_key=api_key, endpoint=endpoint)
    if auto_instrument:
        from swarmtrace.auto_instrument import patch_all
        patch_all()
    if fov:
        from swarmtrace.fov import patch_all as fov_patch_all
        fov_patch_all(watch_dir=fov_watch_dir)
    else:
        # fov=False is the default, and on its own emits nothing, a user on
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
    """Compatibility wrapper around :func:`swarmtrace.config.remote_config`.

    The actual config rules live in ``config.py`` so the runtime and optional
    modules do not need to import private tracer internals. ``tracer.py`` still
    exposes this private helper because older tests and integrations patch it.
    """
    if _api_key is None and _endpoint is None:
        return resolve_remote_config()
    key = _api_key if _api_key is not None else os.environ.get("SWARMTRACE_API_KEY", "")
    endpoint = _endpoint if _endpoint is not None else os.environ.get("SWARMTRACE_ENDPOINT", "")
    return resolve_remote_config(api_key_override=key, endpoint_override=endpoint)


def _validate_endpoint_scheme(url: str) -> tuple[bool, str]:
    """Compatibility alias for ``swarmtrace.config.validate_endpoint_scheme``."""
    return validate_endpoint_scheme(url)


def _normalize_base_url(url: str) -> str:
    """Compatibility alias for ``swarmtrace.config.normalize_base_url``."""
    return normalize_base_url(url)


# Background sender: daemon worker draining a bounded queue. It batches up to
# _BATCH_MAX_ITEMS traces (or flushes after _BATCH_FLUSH_TIMEOUT seconds),
# gzips the {"traces": [...]} body and sends it in one POST, retrying with
# backoff.

# HTTP transport adapter. tracer.py keeps thin shims (_send_remote /
# _send_batch_remote) so existing internal callers and tests that patch
# those names keep working; the actual urllib/gzip work lives in the adapter.
# Phase 1: the repository, transport, and sender are wired together in the
# canonical Runtime, and tracer.py aliases them for backward compatibility.
_transport = HttpTransport()
_repository = SqliteRepository()
_sender = Sender(_transport, _repository, _remote_config)
_runtime = Runtime(_repository, _transport, _remote_config, _sender)
set_runtime(_runtime)

if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_sender.reset_after_fork)


def _send_remote(payload: dict, key: str, url: str) -> None:
    """Send a SINGLE trace payload (legacy single-object shape).

    Used by the resync CLI, which replays one row at a time. The live
    background worker uses _send_batch_remote instead.
    """
    _transport.send_single(payload, key, url)


def _send_batch_remote(payloads: list[dict], key: str, url: str) -> None:
    """Send a BATCH of traces as one gzip'd POST.

    Body shape: ``{"traces": [...]}`` (the new batch shape accepted by
    /api/ingest since swarmtrace 0.6.0). gzip-compressed, trace payloads
    are highly compressible (args/output are repetitive text), so this
    typically shrinks wire bytes 5-10x.
    """
    _transport.send_batch(payloads, key, url)


def _enqueue_remote(payload: dict) -> None:
    """Enqueue a payload for the background sender (shim over _sender.enqueue)."""
    _sender.enqueue(payload)


# Resync, replay unsynced traces to the remote endpoint.
# Used by the ``swarmtrace resync`` CLI. Reads rows where synced=0 from the
# local SQLite DB and POSTs each one to /api/ingest, marking synced=1 on
# success. Synchronous (no background queue) so the CLI can report progress
# and exit code. Returns (attempted, succeeded, failed) counts.

def resync(batch_size: int = 100, retries: int = 3) -> tuple[int, int, int]:
    """Re-send unsynced traces to the remote endpoint.

    Delegates to the canonical Runtime so the resync logic lives in one
    place. Returns ``(attempted, succeeded, failed)``. If the remote endpoint
    isn't configured, returns ``(0, 0, 0)``.
    """
    return get_runtime().resync(batch_size=batch_size, retries=retries)


# Thread-safe & async-safe parent tracking.
# context vars live in trace_context.py and are re-exported here under the
# old private names.


@contextmanager
def session(session_id: str | None = None) -> Iterator[str]:
    """Group every traced call made inside the block into one conversation.

    Usage::

        import swarmtrace

        with swarmtrace.session("conversation-42") as sid:
            chat_agent("hi")          # turn 1
            chat_agent("and then?")   # turn 2, same thread

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


# Shared record-and-save logic

# 'retrieval' was added in the Phase 3 RAG effort, the MCP route's Zod enum
# (frontend-next/app/api/mcp/route.ts), resolve-trace-identity.ts's TraceKind,
# scraper.scrape(kind=...), and the integration test
# test_phase3_retrieval_kind_round_trips all already accept it. The Python
# SDK's primary entry point (@observe) was the only hold-out, see
# docs/SDK_DASHBOARD_CONTRACT.md for the cross-component contract.
_VALID_KINDS  = {"agent", "tool", "llm", "function", "retrieval"}
_KIND_CHOICES = _VALID_KINDS | {"auto"}

# shared pool for _safe_str so we don't spawn a thread per call
_str_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="st-str")


def _resolve_kind(kind: str, enclosing_agent: tuple[str, str] | None) -> str:
    if kind != "auto":
        return kind
    return "agent" if enclosing_agent is None else "function"


def _safe_str(obj, max_len: int = 32000) -> str:
    """Convert *obj* to string safely using a thread-pool (not a new thread per call)."""
    if obj is None:
        return ""
    try:
        fut = _str_pool.submit(lambda: str(obj)[:max_len])
        return fut.result(timeout=0.1)
    except FuturesTimeout:
        return f"<{type(obj).__name__} (stringify timed out)>"
    except Exception:  # noqa: BLE001 -- str(obj) calls arbitrary user __str__/__repr__, must degrade gracefully
        return f"<{type(obj).__name__} (stringify failed)>"


def _build_trace_id() -> str:
    return uuid.uuid4().hex


def _stable_agent_id(func, name: str | None) -> str:
    """Deterministic agent_id for a bare ``@observe`` entrypoint.

    See docs/SDK_DASHBOARD_CONTRACT.md for the agent_id/kind contract.

    The id is a SHA-256 of ``"{module}.{qualname}"`` (or an explicit
    ``name``), so repeat runs of the same function show up as one agent.
    Only used for bare ``@observe``; explicit ``kind="agent"`` gets a fresh id.

    Lambdas all share the qualname ``<lambda>``, so their first line number
    is mixed into the hash. Two lambdas on the same line, or closures from
    one factory, still collide unless you pass ``name=``.
    """
    if name:
        src = name
    else:
        src = f"{func.__module__}.{func.__qualname__}"
        # lambdas: see docstring
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
    parent_id: str | None,
    func_name: str,
    args,
    kwargs,
    output: str | None,
    latency: float,
    error: str | None,
    timestamp: str,
    in_tok: int,
    out_tok: int,
    cost: float,
    kind: str,
    agent_id: str,
    agent_name: str,
    session_id: str | None = None,
    distributed_trace_id: str | None = None,
) -> None:
    # cap args like output (_safe_str); a huge arg would get the row rejected
    # by the server's 64KB body limit and resync would retry it forever
    args_repr = _safe_str(args[:2])
    if kwargs:
        args_repr = f"{args_repr} kwargs={list(kwargs.keys())}"
    # PII redaction, single call site, applied once to args/output/error
    # so the local SQLite DB and the remote ingest endpoint see the SAME
    # scrubbed payload.  Redacting here (not in save_trace / _enqueue_remote)
    # means the two never disagree about what was stored.  See redact.py
    # for the categories scrubbed and the deliberate non-PII pass-through
    # (16-digit trace IDs, UUIDs, SHA-256 hashes are NOT touched).
    args_repr = redact(args_repr)
    output = redact(output)
    error = redact(error)

    span = SpanRecord(
        span_id=trace_id,
        parent_span_id=parent_id,
        trace_id=distributed_trace_id,
        name=func_name,
        kind=kind,
        start_time=datetime.fromisoformat(timestamp),
        latency_sec=latency,
        args=args_repr,
        output=output,
        error=error,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cost_usd=cost,
        agent_id=agent_id,
        agent_name=agent_name,
        session_id=session_id,
    )
    get_runtime().record(span)


def _safe_flush(*flush_args) -> None:
    try:
        _flush(*flush_args)
    except Exception as exc:  # noqa: BLE001 -- storage boundary: must never crash the traced call, already logged
        _log.warning("trace flush warning: %s", exc)


# Decorator

def observe(func=None, *, kind: str = "auto", name: str | None = None,
            session_id: str | None = None):
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

    if inspect.iscoroutinefunction(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            trace_id = _build_trace_id()
            parent_id = _current_parent()
            enclosing_agent = _current_agent()
            distributed_trace_id = _current_trace() or trace_id
            timestamp = datetime.now(timezone.utc).isoformat()
            parent_token = _parent_ctx.set(trace_id)
            trace_token = _trace_ctx.set(distributed_trace_id)

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
            output: str | None = None
            error: str | None = None
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
                    distributed_trace_id,
                )
                _parent_ctx.reset(parent_token)
                _trace_ctx.reset(trace_token)
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
        distributed_trace_id = _current_trace() or trace_id
        timestamp = datetime.now(timezone.utc).isoformat()
        parent_token = _parent_ctx.set(trace_id)
        trace_token = _trace_ctx.set(distributed_trace_id)

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
        output: str | None = None
        error: str | None = None
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
                distributed_trace_id,
            )
            _parent_ctx.reset(parent_token)
            _trace_ctx.reset(trace_token)
            if agent_token is not None:
                _agent_ctx.reset(agent_token)
            if session_token is not None:
                _session_ctx.reset(session_token)

    return sync_wrapper
