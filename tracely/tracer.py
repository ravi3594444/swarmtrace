import time
import uuid
import functools
import contextvars
import asyncio
from datetime import datetime
from tracely.storage import save_trace

_current_trace_id = contextvars.ContextVar('trace_id', default=None)

# Pricing per million tokens (Haiku 4.5)
PRICING = {
    "anthropic/claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.00},
    "openai/gpt-4o-mini":                  {"input": 0.15, "output": 0.60},
    "openai/gpt-4o":                       {"input": 2.50, "output": 10.00},
    "default":                             {"input": 1.00, "output": 3.00},
}

def get_cost(model, input_tokens, output_tokens):
    price = PRICING.get(model, PRICING["default"])
    return round(
        (input_tokens * price["input"] / 1_000_000) +
        (output_tokens * price["output"] / 1_000_000), 8
    )

def count_tokens_accurately(text: str) -> int:
    """Use tiktoken for accurate token counting when available."""
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")  # works for GPT-4, Claude approx
        return len(enc.encode(str(text)))
    except ImportError:
        return max(1, len(str(text)) // 4)

def extract_real_tokens(result):
    """Try to extract real token counts from LLM response objects."""
    try:
        # Anthropic SDK response object
        if hasattr(result, "usage"):
            usage = result.usage
            # Anthropic style
            if hasattr(usage, "input_tokens"):
                return usage.input_tokens, usage.output_tokens
            # OpenAI style
            if hasattr(usage, "prompt_tokens"):
                return usage.prompt_tokens, usage.completion_tokens

        # OpenAI ChatCompletion dict
        if isinstance(result, dict):
            u = result.get("usage", {})
            if u:
                inp = u.get("input_tokens") or u.get("prompt_tokens", 0)
                out = u.get("output_tokens") or u.get("completion_tokens", 0)
                return inp, out

        # LitAI / plain string — no token data available
        return None, None
    except:
        return None, None

def _get_parent_id():
    return _current_trace_id.get()

def _set_parent_id(trace_id):
    return _current_trace_id.set(trace_id)

def _save(trace_id, parent_id, func_name, args, result, latency, error, model="default"):
    # Try real tokens first, fall back to estimate
    input_tokens, output_tokens = extract_real_tokens(result)
    source = "exact"
    if input_tokens is None:
        input_tokens = max(1, len(str(args)) // 4)
        output_tokens = max(1, len(str(result)) // 4) if result else 0
        source = "estimated"

    cost = get_cost(model, input_tokens, output_tokens)

    indent = "  " if parent_id else ""
    status = "✗ FAILED" if error else "✓ done"
    print(f"[Tracely] {indent}{status}: {func_name} | {latency}s | {input_tokens}in/{output_tokens}out ({source}) | ${cost}")

    save_trace({
        "id": trace_id,
        "parent_id": parent_id,
        "function": func_name,
        "args": str(args)[:200],
        "output": str(result)[:200] if result else None,
        "latency_sec": latency,
        "error": str(error) if error else None,
        "timestamp": datetime.utcnow().isoformat(),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost
    })

def observe(func=None, model="default"):
    """
    Usage:
        @observe
        def my_agent(): ...

        @observe(model="anthropic/claude-haiku-4-5-20251001")
        def my_agent(): ...
    """
    def decorator(f):
        if asyncio.iscoroutinefunction(f):
            @functools.wraps(f)
            async def async_wrapper(*args, **kwargs):
                trace_id = str(uuid.uuid4())[:8]
                parent_id = _get_parent_id()
                prev_token = _set_parent_id(trace_id)
                start = time.time()
                error = None
                result = None
                indent = "  " if parent_id else ""
                print(f"[Tracely] {indent}▶ {f.__name__} started (id={trace_id})")
                try:
                    result = await f(*args, **kwargs)
                except Exception as e:
                    error = e
                finally:
                    latency = round(time.time() - start, 3)
                    _save(trace_id, parent_id, f.__name__, args, result, latency, error, model)
                    _current_trace_id.reset(prev_token)
                if error:
                    raise error
                return result
            return async_wrapper

        @functools.wraps(f)
        def sync_wrapper(*args, **kwargs):
            trace_id = str(uuid.uuid4())[:8]
            parent_id = _get_parent_id()
            prev = parent_id
            _set_parent_id(trace_id)
            start = time.time()
            error = None
            result = None
            indent = "  " if parent_id else ""
            print(f"[Tracely] {indent}▶ {f.__name__} started (id={trace_id})")
            try:
                result = f(*args, **kwargs)
            except Exception as e:
                error = e
            finally:
                latency = round(time.time() - start, 3)
                _save(trace_id, parent_id, f.__name__, args, result, latency, error, model)
                _set_parent_id(prev)
            if error:
                raise error
            return result
        return sync_wrapper

    if func is not None:
        return decorator(func)
    return decorator
