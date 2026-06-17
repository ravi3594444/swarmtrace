"""
Global token-budget tracking for swarmtrace.

Provides a ``@budget`` decorator that accumulates token counts per function
across calls and warns (or hard-stops) when limits are approached.

Usage::

    from swarmtrace.budget import budget, reset

    @observe
    @budget(max_tokens=10_000, warn_at=0.8)
    def my_agent(q):
        return llm.chat(q)

    # Reset counters between test runs:
    reset("my_agent")   # single function
    reset()             # all functions
"""

import asyncio
import functools
import threading
from typing import Optional

_session_tokens: dict[str, int] = {}
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def reset(func_name: Optional[str] = None) -> None:
    """
    Reset token-budget counters.

    - ``reset()``            — clears all tracked functions.
    - ``reset("my_agent")``  — clears only that function.
    """
    with _lock:
        if func_name is None:
            _session_tokens.clear()
        else:
            _session_tokens.pop(func_name, None)


def get_usage() -> dict[str, int]:
    """Return a snapshot of current token usage per function."""
    with _lock:
        return dict(_session_tokens)


# ---------------------------------------------------------------------------
# Internal tracking
# ---------------------------------------------------------------------------

def _count_tokens(text: str) -> int:
    """Best-effort token count: tiktoken when available, fallback to len/4.

    Runs tiktoken in a daemon thread with a 200 ms deadline so a stalled
    tokenizer (e.g. on first load / cache miss) can't block the agent.
    """
    approx = len(text) // 4          # always available as fallback
    result: list[int] = []

    def _try_tiktoken():
        try:
            import tiktoken
            enc = tiktoken.get_encoding("cl100k_base")
            result.append(len(enc.encode(text)))
        except Exception:
            pass

    t = threading.Thread(target=_try_tiktoken, daemon=True)
    t.start()
    t.join(timeout=0.2)
    return result[0] if result else approx


def _track(func_name: str, args, result, max_tokens: int, warn_at: float, hard_stop: bool) -> None:
    in_tok = _count_tokens(str(args))
    out_tok = _count_tokens(str(result)) if result is not None else 0

    with _lock:
        _session_tokens[func_name] = _session_tokens.get(func_name, 0) + in_tok + out_tok
        total = _session_tokens[func_name]

    pct = total / max_tokens
    filled = min(int(pct * 20), 20)
    bar = "█" * filled + "░" * (20 - filled)

    if pct >= 1.0:
        msg = f"[swarmtrace] 🛑 OVER BUDGET: {func_name} [{bar}] {total:,}/{max_tokens:,} tokens"
        print(msg)
        if hard_stop:
            raise RuntimeError(msg)
    elif pct >= warn_at:
        print(
            f"[swarmtrace] ⚠️  WARNING: {func_name} [{bar}] "
            f"{total:,}/{max_tokens:,} tokens ({pct*100:.0f}%) — near limit!"
        )
    else:
        print(
            f"[swarmtrace] 💰 Budget: {func_name} [{bar}] "
            f"{total:,}/{max_tokens:,} tokens ({pct*100:.0f}%)"
        )


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def budget(max_tokens: int = 10_000, warn_at: float = 0.8, hard_stop: bool = False):
    """
    Token-budget decorator — warns when agents approach their token limit.

    Parameters
    ----------
    max_tokens:
        Cumulative token ceiling for this function (across all calls in the session).
    warn_at:
        Fraction of max_tokens at which to print a warning (default 0.8 = 80 %).
    hard_stop:
        If ``True``, raise ``RuntimeError`` when the budget is exceeded.
    """
    def decorator(func):
        if asyncio.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args, **kwargs):
                result = await func(*args, **kwargs)
                _track(func.__name__, args, result, max_tokens, warn_at, hard_stop)
                return result
            return async_wrapper

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            result = func(*args, **kwargs)
            _track(func.__name__, args, result, max_tokens, warn_at, hard_stop)
            return result

        return sync_wrapper
    return decorator
