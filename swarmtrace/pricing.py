"""
Live model pricing — fetched from LiteLLM's community-maintained registry.
Falls back to cached data, then a bundled static snapshot, if the fetch fails
or times out.

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
import re
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

# Dated fallback snapshot of common model prices. Live LiteLLM prices override
# this when available; keep it curated rather than exhaustive.
_BUNDLED_MODEL_PRICING: dict[str, dict[str, float]] = {
    # OpenAI
    "gpt-4o": {"input_cost_per_token": 0.000005, "output_cost_per_token": 0.000015},
    "gpt-4o-mini": {"input_cost_per_token": 0.00000015, "output_cost_per_token": 0.0000006},
    "gpt-4-turbo": {"input_cost_per_token": 0.00001, "output_cost_per_token": 0.00003},
    "gpt-4": {"input_cost_per_token": 0.00003, "output_cost_per_token": 0.00006},
    "gpt-3.5-turbo": {"input_cost_per_token": 0.0000005, "output_cost_per_token": 0.0000015},
    "o1": {"input_cost_per_token": 0.000015, "output_cost_per_token": 0.00006},
    "o1-mini": {"input_cost_per_token": 0.000003, "output_cost_per_token": 0.000012},
    "o3-mini": {"input_cost_per_token": 0.0000011, "output_cost_per_token": 0.0000044},

    # Anthropic
    "claude-3-5-sonnet": {"input_cost_per_token": 0.000003, "output_cost_per_token": 0.000015},
    "claude-3-5-haiku": {"input_cost_per_token": 0.0000008, "output_cost_per_token": 0.000004},
    "claude-3-opus": {"input_cost_per_token": 0.000015, "output_cost_per_token": 0.000075},
    "claude-3-haiku": {"input_cost_per_token": 0.00000025, "output_cost_per_token": 0.00000125},
    "claude-sonnet-4": {"input_cost_per_token": 0.000003, "output_cost_per_token": 0.000015},
    "claude-opus-4": {"input_cost_per_token": 0.000015, "output_cost_per_token": 0.000075},

    # Google Gemini
    "gemini-1.5-pro": {"input_cost_per_token": 0.0000035, "output_cost_per_token": 0.0000105},
    "gemini-1.5-flash": {"input_cost_per_token": 0.00000035, "output_cost_per_token": 0.00000105},
    "gemini-2.0-flash": {"input_cost_per_token": 0.0000001, "output_cost_per_token": 0.0000004},
    "gemini-2.0-flash-lite":
        {"input_cost_per_token": 0.000000075, "output_cost_per_token": 0.0000003},
    "gemini-2.5-pro": {"input_cost_per_token": 0.00000125, "output_cost_per_token": 0.00001},

    # Mistral
    "mistral-large-latest": {"input_cost_per_token": 0.000002, "output_cost_per_token": 0.000006},
    "mistral-small-latest": {"input_cost_per_token": 0.0000002, "output_cost_per_token": 0.0000006},
    "open-mistral-nemo": {"input_cost_per_token": 0.00000005, "output_cost_per_token": 0.00000015},
    "codestral-latest": {"input_cost_per_token": 0.000001, "output_cost_per_token": 0.000003},
    "ministral-8b-latest": {"input_cost_per_token": 0.0000001, "output_cost_per_token": 0.0000003},

    # DeepSeek
    "deepseek-chat": {"input_cost_per_token": 0.00000014, "output_cost_per_token": 0.00000028},
    "deepseek-reasoner": {"input_cost_per_token": 0.00000055, "output_cost_per_token": 0.00000219},

    # Groq / Llama
    "llama-3.1-70b-versatile":
        {"input_cost_per_token": 0.00000059, "output_cost_per_token": 0.00000079},
    "llama-3.1-8b-instant":
        {"input_cost_per_token": 0.00000005, "output_cost_per_token": 0.00000008},
    "llama3-70b-8192": {"input_cost_per_token": 0.0000007, "output_cost_per_token": 0.0000009},
    "llama3-8b-8192": {"input_cost_per_token": 0.0000001, "output_cost_per_token": 0.00000012},
    "mixtral-8x7b-32768": {"input_cost_per_token": 0.0000007, "output_cost_per_token": 0.0000007},

    # Cohere
    "command-r": {"input_cost_per_token": 0.000001, "output_cost_per_token": 0.000002},
    "command-r-plus": {"input_cost_per_token": 0.000003, "output_cost_per_token": 0.000015},

    # xAI
    "grok-beta": {"input_cost_per_token": 0.000005, "output_cost_per_token": 0.000015},
    "grok-2-latest": {"input_cost_per_token": 0.000002, "output_cost_per_token": 0.00001},
    "grok-3-latest": {"input_cost_per_token": 0.000003, "output_cost_per_token": 0.000015},
}


def _needs_refresh() -> bool:
    return _cache_ts == 0.0 or (time.time() - _cache_ts) >= _CACHE_TTL


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
        # Back off for the full TTL before trying again, regardless of
        # whether we've succeeded before. Without the unconditional update
        # here, a fetch that fails *after* an earlier success would leave
        # _cache_ts at its old (now-stale) value, so _needs_refresh() stays
        # True and every subsequent hot-path call re-triggers a new
        # background fetch attempt — hammering a dead network indefinitely
        # instead of waiting the hour.
        with _cache_lock:
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


def _lookup_pricing_entry(table: dict, model: str) -> dict | None:
    """Look up pricing by exact, raw, then normalized model name.

    Last resort: strip an undashed YYYYMMDD suffix (e.g. Anthropic's real
    IDs like 'claude-3-5-sonnet-20241022' — `_normalize_model()` only
    strips dashed 'YYYY-MM-DD' dates, by design, since some providers'
    dated snapshots are priced separately). This candidate is tried last
    so an exact dated entry in the live table always wins first.
    """
    candidates = []
    for candidate in (model, model.lower(), _normalize_model(model)):
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    for candidate in candidates:
        entry = table.get(candidate)
        if entry is not None:
            return entry
    normalized = _normalize_model(model)
    undated = re.sub(r'-\d{8}$', '', normalized)
    if undated and undated != normalized:
        entry = table.get(undated)
        if entry is not None:
            return entry
    return None


def _price_from_entry(entry: dict, input_tokens: int, output_tokens: int) -> float:
    inp = entry.get("input_cost_per_token", 0) * 1_000_000
    out = entry.get("output_cost_per_token", 0) * 1_000_000
    return round((input_tokens * inp + output_tokens * out) / 1_000_000, 8)


def set_model_pricing(model: str, input_per_million: float, output_per_million: float) -> None:
    """Override pricing for any model (takes precedence over live table)."""
    _CUSTOM[model.lower()] = (input_per_million, output_per_million)


def _normalize_model(name: str) -> str:
    """Normalize a model name for pricing lookup.

    Strips:
      - Provider prefixes: 'openai/', 'anthropic/', 'azure/', 'vertex_ai/',
        'bedrock/', 'gemini/', etc. (LiteLLM keys these without the prefix)
      - Date suffixes: '-2024-08-06', '-2025-01-01', etc. (dated snapshots
        are priced the same as the base model)

    Does NOT do substring matching — that was the old behavior and it
    mis-priced models ('gpt-4' substring-matched 'gpt-4o', 'gpt-4-turbo',
    'gpt-4.1', etc., and which one won depended on dict iteration order).
    For a cost-tracking product, a wrong number is worse than no number.
    """
    s = name.lower().strip()
    # Strip provider prefix (everything before the first '/')
    if '/' in s:
        s = s.split('/', 1)[1]
    # Strip date suffix like '-2024-08-06' or '-2025-01-01' at the end
    s = re.sub(r'-\d{4}-\d{2}-\d{2}$', '', s)
    return s


def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Return cost in USD.  Returns 0.0 gracefully on any error.

    Returns 0.0 for unknown models rather than guessing — a wrong cost
    number is worse than no number for a cost-tracking product. Users
    who want a specific model tracked can call set_model_pricing().
    """
    if not model:
        return 0.0

    # Callers pass token counts straight from duck-typed third-party usage
    # objects (None, strings, custom numeric-ish types). Coerce defensively
    # here rather than trusting the type hint — this is invoked from
    # ``finally`` blocks that must never raise, so a bad token value should
    # degrade to a 0.0 cost, not lose the whole trace.
    try:
        input_tokens = int(input_tokens) if input_tokens else 0
    except (TypeError, ValueError):
        input_tokens = 0
    try:
        output_tokens = int(output_tokens) if output_tokens else 0
    except (TypeError, ValueError):
        output_tokens = 0

    if input_tokens == 0 and output_tokens == 0:
        return 0.0

    try:
        key = model.lower()

        # Custom overrides first (no network, no lock needed).
        if key in _CUSTOM:
            inp, out = _CUSTOM[key]
            return round((input_tokens * inp + output_tokens * out) / 1_000_000, 8)

        # Live pricing table (single fetch per hour, thread-safe).
        entry = _lookup_pricing_entry(_fetch_live(), model)
        if entry is not None:
            return _price_from_entry(entry, input_tokens, output_tokens)

        entry = _lookup_pricing_entry(_BUNDLED_MODEL_PRICING, model)
        if entry is not None:
            return _price_from_entry(entry, input_tokens, output_tokens)

        return 0.0
    except Exception:
        return 0.0

def warm_cache() -> None:
    """Kick off a background fetch so the cache is warm before the first agent call.

    Called at module import time. If the fetch fails or the network is
    unavailable, calculate_cost() falls back to the bundled snapshot — no
    crash, no block.
    """
    _maybe_trigger_refresh()


# Pre-warm on import — ensures the first calculate_cost() call hits the cache
# instead of blocking the traced thread for up to _FETCH_TIMEOUT seconds.
warm_cache()
