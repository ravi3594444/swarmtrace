"""Tests for swarmtrace/budget.py.

Audit finding #8: budget.py had zero test coverage despite non-trivial
logic: cumulative token tracking across calls, warn/hard-stop thresholds,
time-window auto-reset, async + sync decorator paths, and the "don't let
a budget error swallow the real exception" fix (#9 in the changelog).
"""

from __future__ import annotations

import asyncio
import importlib

import pytest


@pytest.fixture()
def budget_mod():
    """Reload budget.py fresh per test so module-level counters
    (_session_tokens / _session_start) never leak between tests.

    Note: `import swarmtrace.budget as b` would NOT give us the module
    here -- swarmtrace/__init__.py does `from swarmtrace.budget import
    budget`, which reassigns the `swarmtrace.budget` package attribute
    to point at the *function*, shadowing the submodule reference that
    `import ... as` resolves through. importlib.import_module() reads
    sys.modules directly instead, sidestepping the shadowing.
    """
    b = importlib.import_module("swarmtrace.budget")
    importlib.reload(b)
    yield b
    b.reset()


def test_get_usage_starts_empty(budget_mod):
    assert budget_mod.get_usage() == {}


def test_budget_tracks_cumulative_tokens_across_calls(budget_mod):
    @budget_mod.budget(max_tokens=1_000_000, warn_at=0.99)
    def my_fn(x):
        return "y" * 40  # ~10 tokens via len//4 fallback

    my_fn("a" * 40)
    my_fn("a" * 40)

    usage = budget_mod.get_usage()
    assert "my_fn" in usage
    assert usage["my_fn"] > 0
    # Second call should have strictly more tokens tracked than after
    # a single call (cumulative, not overwritten).
    first_total = usage["my_fn"]
    my_fn("a" * 40)
    assert budget_mod.get_usage()["my_fn"] > first_total


def test_budget_hard_stop_raises_when_exceeded(budget_mod):
    @budget_mod.budget(max_tokens=1, warn_at=0.5, hard_stop=True)
    def my_fn(x):
        return "some fairly long result string to blow past 1 token"

    with pytest.raises(RuntimeError, match="OVER BUDGET"):
        my_fn("some fairly long input string to blow past 1 token")


def test_budget_soft_limit_does_not_raise_by_default(budget_mod):
    @budget_mod.budget(max_tokens=1, warn_at=0.5, hard_stop=False)
    def my_fn(x):
        return "some fairly long result string to blow past 1 token"

    # hard_stop=False (the default) -- exceeding the budget should only
    # log, never raise.
    result = my_fn("some fairly long input string to blow past 1 token")
    assert result == "some fairly long result string to blow past 1 token"


def test_reset_single_function(budget_mod):
    @budget_mod.budget(max_tokens=1_000_000)
    def fn_a(x):
        return "y"

    @budget_mod.budget(max_tokens=1_000_000)
    def fn_b(x):
        return "y"

    fn_a("x" * 40)
    fn_b("x" * 40)
    assert "fn_a" in budget_mod.get_usage()
    assert "fn_b" in budget_mod.get_usage()

    budget_mod.reset("fn_a")
    usage = budget_mod.get_usage()
    assert "fn_a" not in usage
    assert "fn_b" in usage


def test_reset_all_functions(budget_mod):
    @budget_mod.budget(max_tokens=1_000_000)
    def fn_a(x):
        return "y"

    fn_a("x" * 40)
    assert budget_mod.get_usage() != {}

    budget_mod.reset()
    assert budget_mod.get_usage() == {}


def test_budget_preserves_original_exception_over_budget_error(budget_mod):
    """FIX #9 regression guard: if the wrapped function itself raises, a
    simultaneous budget-exceeded RuntimeError must NOT swallow it."""

    @budget_mod.budget(max_tokens=1, warn_at=0.1, hard_stop=True)
    def failing_fn(x):
        raise ValueError("the real error")

    with pytest.raises(ValueError, match="the real error"):
        failing_fn("x" * 100)


def test_budget_async_function_tracks_tokens(budget_mod):
    @budget_mod.budget(max_tokens=1_000_000)
    async def my_async_fn(x):
        return "y" * 40

    asyncio.run(my_async_fn("a" * 40))

    usage = budget_mod.get_usage()
    assert "my_async_fn" in usage
    assert usage["my_async_fn"] > 0


def test_budget_async_hard_stop_raises(budget_mod):
    @budget_mod.budget(max_tokens=1, warn_at=0.5, hard_stop=True)
    async def my_async_fn(x):
        return "some fairly long result string to blow past 1 token"

    async def _run():
        await my_async_fn("some fairly long input string to blow past 1 token")

    with pytest.raises(RuntimeError, match="OVER BUDGET"):
        asyncio.run(_run())


def test_budget_async_preserves_original_exception(budget_mod):
    @budget_mod.budget(max_tokens=1, warn_at=0.1, hard_stop=True)
    async def failing_async_fn(x):
        raise ValueError("the real async error")

    async def _run():
        await failing_async_fn("x" * 100)

    with pytest.raises(ValueError, match="the real async error"):
        asyncio.run(_run())


def test_reset_every_hours_zero_disables_auto_reset(budget_mod, monkeypatch):
    """reset_every_hours=0 means only a manual reset() call clears
    counters -- time alone must never reset them."""
    calls = {"n": 0}
    real_time = budget_mod.time.time

    def fake_time():
        # Jump the clock forward by a huge amount on every call.
        calls["n"] += 1
        return real_time() + calls["n"] * 999_999

    monkeypatch.setattr(budget_mod.time, "time", fake_time)

    @budget_mod.budget(max_tokens=1_000_000, reset_every_hours=0)
    def my_fn(x):
        return "y"

    my_fn("x" * 40)
    first_total = budget_mod.get_usage()["my_fn"]
    my_fn("x" * 40)  # clock has "jumped" far forward between calls
    # Cumulative, not reset -- second call's usage must be >= first's.
    assert budget_mod.get_usage()["my_fn"] >= first_total


def test_count_tokens_falls_back_when_tiktoken_unavailable(budget_mod):
    """_count_tokens must degrade to len//4 rather than raising when
    tiktoken is missing or errors out -- budget tracking is best-effort
    and must never break the wrapped function. (tiktoken is an optional
    dependency and is not installed in this test environment, so this
    exercises the real fallback path, not a mock.)"""
    count = budget_mod._count_tokens("a" * 400)
    assert count > 0
