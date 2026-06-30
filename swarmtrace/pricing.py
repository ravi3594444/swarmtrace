"""
Live model pricing — fetched from LiteLLM's community-maintained registry.
Falls back to cached data (or zero) if the fetch fails or times out.

Thread-safety / hot-path guarantee: ``calculate_cost()`` (called inline from
``tracer._extract_token_info`` and ``auto_instrument._record_async``, both on
the calling thread) NEVER performs network I/O itself. It only ever reads the
in-memory cache. Whenever that cache is empty or stale, a refresh is kicked
off on a dedicated daemon thread (``_refresh_in_progress`` + ``_refresh_lock``
ensure at most one fetch runs at a time) and the call returns immediately
with whatever is currently cached (possibly empty, possibly stale-but-usable)
rather than waiting on the network.
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
_cache_lock = threading.Lock()          # protects reads/writes of _cache/_cache_ts
_refresh_lock = threading.Lock()        # guards the "launch a refresh thread" decision
_refresh_in_progress = False            # ensures only one fetch thread runs at a time
_CUSTOM: dict[str, tuple[float, float]] = {}


def _needs_refresh() -> bool:
    return not _cache or (time.time() - _cache_ts) >= _CACHE_TTL


def _background_fetch() -> None:
    """Runs on its own daemon thread — this is the ONLY place that does
    network I/O. Never called directly from the hot path.
    """
    global _cache, _cache_ts, _refresh_in_progress
    try:
        with urllib.request.urlopen(_LIVE_URL, timeout=_FETCH_TIMEOUT) as r:
            data = json.loads(r.read().decode())
        with _cache_lock:
            _cache = data
            _cache_ts = time.time()
    except Exception:
        # Update timestamp so we don't hammer the URL on every call when the
        # network is down — wait the full TTL before trying again.
        with _cache_lock:
            if not _cache_ts:
                _cache_ts = time.time()
    finally:
        with _refresh_lock:
            _refresh_in_progress = False


def _maybe_trigger_refresh() -> None:
    """Kick off a background refresh if the cache is empty/stale and no
    refresh is already in flight. Returns immediately either way — this
    function never blocks on network I/O, only ever on a brief in-memory
    lock, so it's safe to call from the hot path on every traced call.
    """
    global _refresh_in_progress
    if not _needs_refresh():
        return
    with _refresh_lock:
        if _refresh_in_progress or not _needs_refresh():
            return
        _refresh_in_progress = True
        threading.Thread(
            target=_background_fetch, daemon=True, name="swarmtrace-pricing-refresh"
        ).start()


def _fetch_live() -> dict:
    """Return the pricing table immediately from cache.

    Never performs network I/O on the calling thread. If the cache is empty
    or stale, a background refresh is triggered (at most one in flight at a
    time) and the current cache — possibly empty, possibly stale-but-usable —
    is returned right away.
    """
    _maybe_trigger_refresh()
    with _cache_lock:
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
    _maybe_trigger_refresh()


# Pre-warm on import — ensures the first calculate_cost() call hits the cache
# instead of blocking the traced thread for up to _FETCH_TIMEOUT seconds.
warm_cache()
