"""
Global token-budget tracking for swarmtrace.

Provides a ``@budget`` decorator that accumulates token counts per function
across calls and warns (or hard-stops) when limits are approached.

Usage::

    from swarmtrace.budget import budget, reset

    @observe
    @budget(max_tokens=100_000, warn_at=0.8, reset_every_hours=24)
    def my_agent(q):
        return llm.chat(q)

    # Reset counters manually between runs:
    reset("my_agent")   # single function
    reset()             # all functions
"""

import functools
import inspect
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

_log = logging.getLogger("swarmtrace.budget")

_session_tokens: dict[str, int] = {}
_session_start:  dict[str, float] = {}
_lock = threading.Lock()

# FIX #3 (budget): use a pool instead of spawning a new thread per _count_tokens call.
# _count_tokens is called TWICE per traced call (args + result) — in a busy agent loop
# this was creating hundreds of OS threads per second.
_tok_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="st-tok")

# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def reset(func_name: str | None = None) -> None:
    """
    Reset token-budget counters.

    - ``reset()``            — clears all tracked functions.
    - ``reset("my_agent")``  — clears only that function.
    """
    with _lock:
        if func_name is None:
            _session_tokens.clear()
            _session_start.clear()
        else:
            _session_tokens.pop(func_name, None)
            _session_start.pop(func_name, None)


def get_usage() -> dict[str, int]:
    """Return a snapshot of current token usage per function."""
    with _lock:
        return dict(_session_tokens)


# ---------------------------------------------------------------------------
# Internal tracking
# ---------------------------------------------------------------------------

def _count_tokens(text: str) -> int:
    """Best-effort token count: tiktoken when available, fallback to len/4.

    Uses a thread-pool (not a new thread per call) to avoid OS thread
    explosion in high-frequency agent loops.
    """
    approx = len(text) // 4

    def _try_tiktoken():
        try:
            import tiktoken
            enc = tiktoken.get_encoding("cl100k_base")
            return len(enc.encode(text))
        except Exception:
            return approx

    try:
        fut = _tok_pool.submit(_try_tiktoken)
        return fut.result(timeout=0.2)
    except (FuturesTimeout, Exception):
        return approx


def _track(
    func_name: str,
    args,
    result,
    max_tokens: int,
    warn_at: float,
    hard_stop: bool,
    reset_every_hours: float,
) -> None:
    in_tok = _count_tokens(str(args))
    out_tok = _count_tokens(str(result)) if result is not None else 0

    with _lock:
        now = time.time()

        # FIX #8: auto-reset counters on a time window so budget isn't
        # permanently tripped for long-running 24/7 agents.
        # Without this, max_tokens=10_000 trips after ~10 min and never resets.
        if reset_every_hours > 0:
            last_start = _session_start.get(func_name, 0.0)
            if now - last_start >= reset_every_hours * 3600:
                _session_tokens[func_name] = 0
                _session_start[func_name] = now

        _session_tokens[func_name] = _session_tokens.get(func_name, 0) + in_tok + out_tok
        total = _session_tokens[func_name]

    pct = total / max_tokens
    filled = min(int(pct * 20), 20)
    bar = "█" * filled + "░" * (20 - filled)

    if pct >= 1.0:
        msg = f"OVER BUDGET: {func_name} [{bar}] {total:,}/{max_tokens:,} tokens"
        _log.error(msg)
        if hard_stop:
            raise RuntimeError(f"[swarmtrace] {msg}")
    elif pct >= warn_at:
        _log.warning(
            "WARNING: %s [%s] %s/%s tokens (%d%%) — near limit!",
            func_name, bar, f"{total:,}", f"{max_tokens:,}", int(pct * 100),
        )
    else:
        _log.info(
            "Budget: %s [%s] %s/%s tokens (%d%%)",
            func_name, bar, f"{total:,}", f"{max_tokens:,}", int(pct * 100),
        )


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def budget(
    max_tokens: int = 100_000,
    warn_at: float = 0.8,
    hard_stop: bool = False,
    reset_every_hours: float = 24.0,
):
    """
    Token-budget decorator — warns when agents approach their token limit.

    Parameters
    ----------
    max_tokens:
        Cumulative token ceiling for this function within the current window.
        Default raised to 100,000 (was 10,000 — the old default tripped in
        ~10 minutes for any real LLM agent).
    warn_at:
        Fraction of max_tokens at which to print a warning (default 0.8 = 80%).
    hard_stop:
        If ``True``, raise ``RuntimeError`` when the budget is exceeded.
    reset_every_hours:
        Automatically reset the counter every N hours (default 24).
        Set to 0 to disable auto-reset (manual ``reset()`` only).
    """
    def decorator(func):
        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args, **kwargs):
                result = None
                original_exc: BaseException | None = None
                try:
                    result = await func(*args, **kwargs)
                    return result
                except BaseException as exc:
                    original_exc = exc
                    raise
                finally:
                    # FIX #9: don't let a budget RuntimeError swallow the
                    # original exception — only raise budget error if there
                    # was no prior exception in flight.
                    try:
                        _track(func.__name__, args, result, max_tokens, warn_at,
                               hard_stop, reset_every_hours)
                    except RuntimeError:
                        if original_exc is None:
                            raise  # no original exc → budget error is the error
                        # else: let the original exc propagate naturally
            return async_wrapper

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            result = None
            original_exc: BaseException | None = None
            try:
                result = func(*args, **kwargs)
                return result
            except BaseException as exc:
                original_exc = exc
                raise
            finally:
                try:
                    _track(func.__name__, args, result, max_tokens, warn_at,
                           hard_stop, reset_every_hours)
                except RuntimeError:
                    if original_exc is None:
                        raise

        return sync_wrapper
    return decorator
