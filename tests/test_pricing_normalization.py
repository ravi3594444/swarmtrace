"""Regression tests for the pricing.py model-name normalization fix.

Bug: calculate_cost() used bidirectional substring matching as a fallback
when an exact match wasn't found:
    if key in name.lower() or name.lower() in key

This meant 'gpt-4' substring-matched 'gpt-4o', 'gpt-4-turbo', 'gpt-4.1',
etc., and which model's price won depended on dict iteration order. For
a cost-tracking product, a quietly wrong per-token rate is worse than
no number.

Fix: replaced the fuzzy fallback with proper normalization (strip
provider prefix + date suffix), then exact match. Returns 0.0 for
unknown models instead of guessing.

These tests pin the fix so a future refactor can't silently reintroduce
the substring-matching bug with green CI.
"""

import threading

import pytest

from swarmtrace import pricing


@pytest.fixture(autouse=True)
def reset_pricing_state(monkeypatch):
    """Clean cache/refresh/custom-override state per test, and wait out any
    leftover warm_cache() thread from module import so it can't race a test's
    own mocked fetch. Same pattern as test_pricing.py, plus _CUSTOM clearing
    so set_model_pricing() calls in one test don't leak into the next.
    """
    for t in threading.enumerate():
        if t.name in ("swarmtrace-pricing-warm", "swarmtrace-pricing-refresh") and t.is_alive():
            t.join(timeout=5)
    monkeypatch.setattr(pricing, "_cache", {})
    monkeypatch.setattr(pricing, "_cache_ts", 0.0)
    monkeypatch.setattr(pricing, "_refresh_in_progress", False)
    monkeypatch.setattr(pricing, "_CUSTOM", {})
    yield


# ── Mock pricing table for tests ────────────────────────────────────────────
# Realistic per-token costs (from LiteLLM's registry, approx).
# input_cost_per_token is in USD/token (so 0.0000025 = $2.50 per million).
MOCK_TABLE = {
    "gpt-4o":                 {"input_cost_per_token": 0.0000025,  "output_cost_per_token": 0.00001},
    "gpt-4o-mini":            {"input_cost_per_token": 0.00000015, "output_cost_per_token": 0.0000006},
    "gpt-4-turbo":            {"input_cost_per_token": 0.00001,    "output_cost_per_token": 0.00003},
    "claude-3-5-sonnet":      {"input_cost_per_token": 0.000003,   "output_cost_per_token": 0.000015},
    "claude-3-haiku":         {"input_cost_per_token": 0.00000025, "output_cost_per_token": 0.00000125},
    "gemini-1.5-flash":       {"input_cost_per_token": 0.000000075, "output_cost_per_token": 0.0000003},
}


def _load_mock_table(monkeypatch):
    """Populate the cache with MOCK_TABLE and mark it fresh so no
    background fetch fires during the test."""
    monkeypatch.setattr(pricing, "_cache", dict(MOCK_TABLE))
    monkeypatch.setattr(pricing, "_cache_ts", float("inf"))  # never stale


# ── _normalize_model unit tests ──────────────────────────────────────────────

def test_normalize_strips_provider_prefix():
    assert pricing._normalize_model("openai/gpt-4o") == "gpt-4o"
    assert pricing._normalize_model("anthropic/claude-3-5-sonnet") == "claude-3-5-sonnet"
    assert pricing._normalize_model("azure/gpt-4-turbo") == "gpt-4-turbo"
    assert pricing._normalize_model("vertex_ai/gemini-1.5-flash") == "gemini-1.5-flash"
    assert pricing._normalize_model("bedrock/anthropic.claude-3-haiku") == "anthropic.claude-3-haiku"


def test_normalize_strips_date_suffix():
    assert pricing._normalize_model("gpt-4o-2024-08-06") == "gpt-4o"
    assert pricing._normalize_model("claude-3-5-sonnet-20241022") != "claude-3-5-sonnet"  # YYYYMMDD not stripped — only YYYY-MM-DD
    assert pricing._normalize_model("claude-3-5-sonnet-2024-10-22") == "claude-3-5-sonnet"
    assert pricing._normalize_model("gpt-4-turbo-2024-04-09") == "gpt-4-turbo"


def test_normalize_strips_both_prefix_and_date():
    assert pricing._normalize_model("openai/gpt-4o-2024-08-06") == "gpt-4o"
    assert pricing._normalize_model("anthropic/claude-3-5-sonnet-2024-10-22") == "claude-3-5-sonnet"


def test_normalize_passes_through_already_clean_names():
    assert pricing._normalize_model("gpt-4o") == "gpt-4o"
    assert pricing._normalize_model("claude-3-5-sonnet") == "claude-3-5-sonnet"


def test_normalize_lowercases():
    assert pricing._normalize_model("GPT-4o") == "gpt-4o"
    assert pricing._normalize_model("OpenAI/GPT-4o") == "gpt-4o"


# ── calculate_cost: the mis-pricing regression test ─────────────────────────
# This is the core test. 'gpt-4' must NOT pick up 'gpt-4o's price via
# substring match. The old code would have matched because:
#   "gpt-4" in "gpt-4o"  →  True  (substring fallback)
# With the bundled fallback, 'gpt-4' now has its own price and still must
# not be mis-priced as 'gpt-4o'.

def test_gpt4_does_not_steal_gpt4o_price(monkeypatch):
    """THE regression test: 'gpt-4' must not be priced as 'gpt-4o'."""
    _load_mock_table(monkeypatch)

    cost_gpt4 = pricing.calculate_cost("gpt-4", input_tokens=1000, output_tokens=500)
    cost_gpt4o = pricing.calculate_cost("gpt-4o", input_tokens=1000, output_tokens=500)

    # gpt-4o is in the table → has a real price
    assert cost_gpt4o > 0, "gpt-4o should have a price from the mock table"
    # gpt-4 is bundled → must keep its own price, not gpt-4o's price.
    assert cost_gpt4 == pytest.approx(0.06, abs=0.001), (
        f"gpt-4 mis-priced as {cost_gpt4} (gpt-4o is {cost_gpt4o}) — "
        "substring-matching bug reintroduced?"
    )
    # Belt-and-suspenders: explicitly confirm they're not equal
    assert cost_gpt4 != cost_gpt4o


def test_gpt4_does_not_steal_gpt4_turbo_price(monkeypatch):
    """Same regression, different model pair: 'gpt-4' must not match 'gpt-4-turbo'."""
    _load_mock_table(monkeypatch)

    cost_gpt4 = pricing.calculate_cost("gpt-4", input_tokens=1000, output_tokens=500)
    cost_gpt4_turbo = pricing.calculate_cost("gpt-4-turbo", input_tokens=1000, output_tokens=500)

    assert cost_gpt4_turbo > 0
    assert cost_gpt4 == pytest.approx(0.06, abs=0.001), (
        f"gpt-4 mis-priced as {cost_gpt4} (gpt-4-turbo is {cost_gpt4_turbo})"
    )


def test_gpt4o_mini_does_not_steal_gpt4o_price(monkeypatch):
    """'gpt-4o-mini' must not match 'gpt-4o' — they have very different prices."""
    _load_mock_table(monkeypatch)

    cost_mini = pricing.calculate_cost("gpt-4o-mini", input_tokens=1_000_000, output_tokens=0)
    cost_full = pricing.calculate_cost("gpt-4o", input_tokens=1_000_000, output_tokens=0)

    # gpt-4o-mini is $0.15/M input; gpt-4o is $2.50/M input — 16x difference
    assert cost_mini == pytest.approx(0.15, abs=0.001), f"gpt-4o-mini mis-priced: {cost_mini}"
    assert cost_full == pytest.approx(2.50, abs=0.001), f"gpt-4o mis-priced: {cost_full}"
    assert cost_mini != cost_full


# ── calculate_cost: normalization still works for legitimate cases ──────────

def test_provider_prefix_normalized_correctly(monkeypatch):
    """'openai/gpt-4o' should match 'gpt-4o' in the table via prefix strip."""
    _load_mock_table(monkeypatch)

    cost_with_prefix = pricing.calculate_cost("openai/gpt-4o", input_tokens=1000, output_tokens=500)
    cost_without_prefix = pricing.calculate_cost("gpt-4o", input_tokens=1000, output_tokens=500)

    assert cost_with_prefix > 0, "provider-prefixed model should resolve via normalization"
    assert cost_with_prefix == cost_without_prefix, (
        f"openai/gpt-4o ({cost_with_prefix}) != gpt-4o ({cost_without_prefix}) — "
        "prefix normalization broken"
    )


def test_date_suffix_normalized_correctly(monkeypatch):
    """'gpt-4o-2024-08-06' should match 'gpt-4o' in the table via date strip."""
    _load_mock_table(monkeypatch)

    cost_with_date = pricing.calculate_cost("gpt-4o-2024-08-06", input_tokens=1000, output_tokens=500)
    cost_without_date = pricing.calculate_cost("gpt-4o", input_tokens=1000, output_tokens=500)

    assert cost_with_date > 0, "dated model should resolve via normalization"
    assert cost_with_date == cost_without_date, (
        f"gpt-4o-2024-08-06 ({cost_with_date}) != gpt-4o ({cost_without_date}) — "
        "date normalization broken"
    )


def test_prefix_and_date_normalized_together(monkeypatch):
    """'openai/gpt-4o-2024-08-06' should match 'gpt-4o' (both prefix + date stripped)."""
    _load_mock_table(monkeypatch)

    cost = pricing.calculate_cost("openai/gpt-4o-2024-08-06", input_tokens=1000, output_tokens=500)
    cost_base = pricing.calculate_cost("gpt-4o", input_tokens=1000, output_tokens=500)

    assert cost > 0
    assert cost == cost_base


def test_case_insensitive_match(monkeypatch):
    """'GPT-4o' should match 'gpt-4o' in the table."""
    _load_mock_table(monkeypatch)

    assert pricing.calculate_cost("GPT-4o", 1000, 500) == pricing.calculate_cost("gpt-4o", 1000, 500)


# ── calculate_cost: unknown models return 0.0, never guess ──────────────────

def test_unknown_model_returns_zero(monkeypatch):
    """Unknown model must return 0.0, not a guessed price from a substring match."""
    _load_mock_table(monkeypatch)

    assert pricing.calculate_cost("llama-3.3-70b", 1000, 500) == 0.0
    assert pricing.calculate_cost("some-future-model", 1000, 500) == 0.0


def test_empty_model_returns_zero(monkeypatch):
    _load_mock_table(monkeypatch)
    assert pricing.calculate_cost("", 1000, 500) == 0.0


def test_zero_tokens_returns_zero(monkeypatch):
    _load_mock_table(monkeypatch)
    assert pricing.calculate_cost("gpt-4o", 0, 0) == 0.0


# ── Custom overrides still take precedence ──────────────────────────────────

def test_custom_override_takes_precedence(monkeypatch):
    """set_model_pricing() override must win over the live table, even when
    the override key is a substring of a table key (no substring matching
    in the override path either)."""
    _load_mock_table(monkeypatch)
    pricing.set_model_pricing("gpt-4", input_per_million=1.00, output_per_million=5.00)

    # gpt-4 now has a custom price; gpt-4o uses the table
    cost_gpt4 = pricing.calculate_cost("gpt-4", 1_000_000, 0)
    cost_gpt4o = pricing.calculate_cost("gpt-4o", 1_000_000, 0)

    assert cost_gpt4 == pytest.approx(1.00, abs=0.001)
    assert cost_gpt4o == pytest.approx(2.50, abs=0.001)
    assert cost_gpt4 != cost_gpt4o


# ── The full mis-pricing scenario from the original bug report ──────────────

def test_no_model_steals_another_models_price(monkeypatch):
    """Comprehensive: every model in the table should only match itself,
    not any other model that happens to contain it as a substring."""
    _load_mock_table(monkeypatch)

    # Substrings of real table keys — none of these are in the table
    # themselves, so they must all return 0.0 (not steal the parent's price)
    not_in_table = [
        "gpt-4-prototype",  # substring of gpt-4, gpt-4o, gpt-4-turbo, gpt-4o-mini
        "gpt-4o-mini-",   # different from gpt-4o-mini
        "claude-3",       # substring of claude-3-5-sonnet, claude-3-haiku
        "claude",         # substring of all claude models
        "gemini",         # substring of gemini-1.5-flash
        "flash",          # substring of gemini-1.5-flash
        "sonnet",         # substring of claude-3-5-sonnet
    ]
    for model in not_in_table:
        cost = pricing.calculate_cost(model, 1000, 500)
        assert cost == 0.0, (
            f"'{model}' stole a price ({cost}) via substring match — "
            "the fuzzy-matching bug is back"
        )
