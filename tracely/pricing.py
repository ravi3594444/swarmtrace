"""
Live model pricing — fetched from LiteLLM's community-maintained pricing registry.
Falls back to cached data if the fetch fails.
"""

from __future__ import annotations
import json
import time
import urllib.request

_LIVE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
_CACHE_TTL = 60 * 60  # refresh every 1 hour

_cache: dict = {}
_cache_ts: float = 0.0
_CUSTOM: dict[str, tuple[float, float]] = {}


def _fetch_live() -> dict:
    global _cache, _cache_ts
    if _cache and (time.time() - _cache_ts) < _CACHE_TTL:
        return _cache
    try:
        with urllib.request.urlopen(_LIVE_URL, timeout=3) as r:
            _cache = json.loads(r.read().decode())
            _cache_ts = time.time()
    except Exception:
        pass
    return _cache


def set_model_pricing(model: str, input_per_million: float, output_per_million: float) -> None:
    """Override pricing for any model."""
    _CUSTOM[model.lower()] = (input_per_million, output_per_million)


def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    if not model or (input_tokens == 0 and output_tokens == 0):
        return 0.0

    key = model.lower()

    # Custom overrides first
    if key in _CUSTOM:
        inp, out = _CUSTOM[key]
        return round((input_tokens * inp + output_tokens * out) / 1_000_000, 8)

    # Live pricing table
    table = _fetch_live()

    # Exact match first, then substring fallback
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
