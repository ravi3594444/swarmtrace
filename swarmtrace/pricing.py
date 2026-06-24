"""
Live model pricing — fetched from LiteLLM's community-maintained registry.
Falls back to cached data (or zero) if the fetch fails or times out.

Thread-safety: a module-level lock ensures only one thread fetches at a time;
all others get the cached value immediately. The fetch happens on the
background sender thread (via swarmtrace.tracer._enqueue_pricing_refresh), never
on the agent's hot path.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request

_LIVE_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)
_CACHE_TTL = 60 * 60       # refresh every 1 hour
_FETCH_TIMEOUT = 5         # seconds; 3 was too tight for cold starts

_cache: dict = {}
_cache_ts: float = 0.0
_cache_lock = threading.Lock()          # ensures only one fetch at a time
_CUSTOM: dict[str, tuple[float, float]] = {}


def _needs_refresh() -> bool:
    return not _cache or (time.time() - _cache_ts) >= _CACHE_TTL


def _fetch_live() -> dict:
    """Return the pricing table, fetching at most once per TTL window.

    Safe to call from any thread: the lock prevents thundering-herd fetches.
    If the fetch fails for any reason (network, timeout, parse error) the
    existing cache is returned unchanged — callers get stale-but-correct
    data rather than a 0-cost false positive.
    """
    global _cache, _cache_ts

    # Fast path — no lock needed for a stale-read check.
    if not _needs_refresh():
        return _cache

    # Slow path — acquire lock so only one thread fetches.
    with _cache_lock:
        # Re-check after acquiring: another thread may have refreshed already.
        if not _needs_refresh():
            return _cache
        try:
            with urllib.request.urlopen(_LIVE_URL, timeout=_FETCH_TIMEOUT) as r:
                data = json.loads(r.read().decode())
            _cache = data
            _cache_ts = time.time()
        except Exception:
            # Update timestamp so we don't hammer the URL on every call when
            # the network is down — wait the full TTL before trying again.
            if not _cache_ts:
                _cache_ts = time.time()
    return _cache


def set_model_pricing(model: str, input_per_million: float, output_per_million: float) -> None:
    """Override pricing for any model (takes precedence over live table)."""
    _CUSTOM[model.lower()] = (input_per_million, output_per_million)


def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Return cost in USD.  Returns 0.0 gracefully on any error."""
    if not model or (input_tokens == 0 and output_tokens == 0):
        return 0.0

    key = model.lower()

    # Custom overrides first (no network, no lock needed).
    if key in _CUSTOM:
        inp, out = _CUSTOM[key]
        return round((input_tokens * inp + output_tokens * out) / 1_000_000, 8)

    # Live pricing table (single fetch per hour, thread-safe).
    table = _fetch_live()
    if not table:
        return 0.0

    # Exact match first, then substring fallback.
    entry = table.get(key) or table.get(model)
    if not entry:
        for name, data in table.items():
            if key in name.lower() or name.lower() in key:
                entry = data
                break

    if entry:
        inp = entry.get("input_cost_per_token", 0) * 1_000_000
        out = entry.get("output_cost_per_token", 0) * 1_000_000
        return round((input_tokens * inp + output_tokens * out) / 1_000_000, 8)

    return 0.0

def warm_cache() -> None:
    """Kick off a background fetch so the cache is warm before the first agent call.

    Called at module import time. If the fetch fails or the network is
    unavailable, calculate_cost() falls back to 0.0 — no crash, no block.
    """
    threading.Thread(target=_fetch_live, daemon=True, name="swarmtrace-pricing-warm").start()


# Pre-warm on import — ensures the first calculate_cost() call hits the cache
# instead of blocking the traced thread for up to _FETCH_TIMEOUT seconds.
warm_cache()
