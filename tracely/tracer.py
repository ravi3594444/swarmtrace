import functools
import time
import uuid
import asyncio
from datetime import datetime, timezone

from tracely.storage import save_trace

# Thread-safe async-safe parent tracking via contextvars
import contextvars
_parent_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar("parent_ctx", default=None)
_parent_stack = []  # kept for backward compat with scraper.py

def _current_parent() -> str | None:
    return _parent_ctx.get()


def observe(func):
    """
    Decorator that records every call (sync or async) to the traces DB.

    Usage:
        @observe
        def my_agent(prompt): ...

        @observe
        async def my_async_agent(prompt): ...
    """

    if asyncio.iscoroutinefunction(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            trace_id  = uuid.uuid4().hex[:8]
            parent_id = _current_parent()
            timestamp = datetime.now(timezone.utc).isoformat()
            token = _parent_ctx.set(trace_id)

            start   = time.perf_counter()
            output  = None
            error   = None
            in_tok  = 0
            out_tok = 0
            cost    = 0.0

            try:
                result  = await func(*args, **kwargs)
                output  = str(result)[:4000]
                if hasattr(result, "input_tokens"):
                    in_tok  = result.input_tokens or 0
                    out_tok = result.output_tokens or 0
                    cost    = result.cost_usd or 0.0
                return result
            except Exception as exc:
                error = str(exc)
                raise
            finally:
                latency = round(time.perf_counter() - start, 3)
                save_trace(
                    trace_id, parent_id, func.__name__,
                    str(args[:2]),
                    output, latency, error,
                    timestamp, in_tok, out_tok, cost
                )
                _parent_ctx.reset(token)

        return async_wrapper

    else:
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            trace_id  = uuid.uuid4().hex[:8]
            parent_id = _current_parent()
            timestamp = datetime.now(timezone.utc).isoformat()
            _parent_stack.append(trace_id)

            start   = time.perf_counter()
            output  = None
            error   = None
            in_tok  = 0
            out_tok = 0
            cost    = 0.0

            try:
                result  = func(*args, **kwargs)
                output  = str(result)[:4000]
                if hasattr(result, "input_tokens"):
                    in_tok  = result.input_tokens or 0
                    out_tok = result.output_tokens or 0
                    cost    = result.cost_usd or 0.0
                return result
            except Exception as exc:
                error = str(exc)
                raise
            finally:
                latency = round(time.perf_counter() - start, 3)
                save_trace(
                    trace_id, parent_id, func.__name__,
                    str(args[:2]),
                    output, latency, error,
                    timestamp, in_tok, out_tok, cost
                )
                _parent_stack.pop()

        return sync_wrapper
