import functools
import asyncio
import time

# Session-level token tracker
_session_tokens: dict = {}

def budget(max_tokens: int = 10000, warn_at: float = 0.8, hard_stop: bool = False):
    """
    Token budget decorator — warns when agents approach token limits.

    Usage:
        @observe
        @budget(max_tokens=10000, warn_at=0.8)
        def my_agent(q):
            return llm.chat(q)
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

def _track(func_name, args, result, max_tokens, warn_at, hard_stop):
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        in_tok = len(enc.encode(str(args)))
        out_tok = len(enc.encode(str(result))) if result else 0
    except:
        in_tok = len(str(args)) // 4
        out_tok = len(str(result)) // 4 if result else 0

    key = func_name
    _session_tokens[key] = _session_tokens.get(key, 0) + in_tok + out_tok
    total = _session_tokens[key]
    pct = total / max_tokens

    bar_filled = int(pct * 20)
    bar = "█" * bar_filled + "░" * (20 - bar_filled)

    if pct >= 1.0:
        msg = f"[swarmtrace] 🛑 OVER BUDGET: {func_name} [{bar}] {total:,}/{max_tokens:,} tokens"
        print(msg)
        if hard_stop:
            raise RuntimeError(msg)
    elif pct >= warn_at:
        print(f"[swarmtrace] ⚠️  WARNING: {func_name} [{bar}] {total:,}/{max_tokens:,} tokens ({pct*100:.0f}%) — near limit!")
    else:
        print(f"[swarmtrace] 💰 Budget: {func_name} [{bar}] {total:,}/{max_tokens:,} tokens ({pct*100:.0f}%)")
