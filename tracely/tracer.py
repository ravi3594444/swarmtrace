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
"""

import asyncio
import contextvars
import functools
import json
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.request import Request, urlopen

from tracely.storage import save_trace

_REMOTE_KEY: str = os.environ.get("SWARMTRACE_API_KEY", "")
_REMOTE_URL: str = os.environ.get("SWARMTRACE_ENDPOINT", "").rstrip("/")

def _send_remote(payload: dict) -> None:
    try:
        body = json.dumps(payload).encode()
        req = Request(f"{_REMOTE_URL}/ingest", data=body,
            headers={"Content-Type": "application/json", "X-API-Key": _REMOTE_KEY},
            method="POST")
        urlopen(req, timeout=5)
    except Exception as exc:
        print(f"[swarmtrace] remote ingest warning: {exc}", file=sys.stderr)

# Thread-safe & async-safe parent tracking
_parent_ctx: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "parent_ctx", default=None
)


def _current_parent() -> Optional[str]:
    return _parent_ctx.get()


# ---------------------------------------------------------------------------
# Shared record-and-save logic (keeps sync + async wrappers DRY)
# ---------------------------------------------------------------------------

def _build_trace_id() -> str:
    return uuid.uuid4().hex[:8]


def _extract_token_info(result) -> tuple[int, int, float]:
    """Pull token/cost fields off the result if present."""
    if result is not None and hasattr(result, "input_tokens"):
        return (
            result.input_tokens or 0,
            result.output_tokens or 0,
            result.cost_usd or 0.0,
        )
    return 0, 0, 0.0


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
) -> None:
    # Capture up to the first two positional args + any kwargs for the record.
    args_repr = str(args[:2])
    if kwargs:
        args_repr = f"{args_repr} kwargs={list(kwargs.keys())}"
    save_trace(
        trace_id, parent_id, func_name,
        args_repr, output, latency, error,
        timestamp, in_tok, out_tok, cost,
    )

    if _REMOTE_KEY and _REMOTE_URL:
        threading.Thread(target=_send_remote, args=({
            "id": trace_id, "parent_id": parent_id, "function": func_name,
            "args": args_repr, "output": output or "", "latency_sec": latency,
            "error": error, "timestamp": timestamp,
            "input_tokens": in_tok, "output_tokens": out_tok, "cost_usd": cost,
        },), daemon=True).start()


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def observe(func):
    """
    Decorator that records every call (sync or async) to the traces DB.
    Propagates parent–child relationships automatically via contextvars,
    so nested ``@observe`` calls are linked in the tree.
    """
    if asyncio.iscoroutinefunction(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            trace_id = _build_trace_id()
            parent_id = _current_parent()
            timestamp = datetime.now(timezone.utc).isoformat()
            token = _parent_ctx.set(trace_id)

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
                _flush(
                    trace_id, parent_id, func.__name__,
                    args, kwargs, output,
                    round(time.perf_counter() - start, 3),
                    error, timestamp, in_tok, out_tok, cost,
                )
                _parent_ctx.reset(token)

        return async_wrapper

    @functools.wraps(func)
    def sync_wrapper(*args, **kwargs):
        trace_id = _build_trace_id()
        parent_id = _current_parent()
        timestamp = datetime.now(timezone.utc).isoformat()
        token = _parent_ctx.set(trace_id)

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
            _flush(
                trace_id, parent_id, func.__name__,
                args, kwargs, output,
                round(time.perf_counter() - start, 3),
                error, timestamp, in_tok, out_tok, cost,
            )
            _parent_ctx.reset(token)

    return sync_wrapper
