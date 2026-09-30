"""calculate_cost() must never block the caller on a network fetch.

The cache is read inline; refreshes run on one deduplicated background thread.
"""

import threading
import time

import pytest

from swarmtrace import pricing


@pytest.fixture(autouse=True)
def reset_pricing_state(monkeypatch):
    """Reset cache/refresh state and wait out any warm_cache() thread left from import."""
    for t in threading.enumerate():
        if t.name in ("swarmtrace-pricing-warm", "swarmtrace-pricing-refresh") and t.is_alive():
            t.join(timeout=5)
    monkeypatch.setattr(pricing, "_cache", {})
    monkeypatch.setattr(pricing, "_cache_ts", 0.0)
    monkeypatch.setattr(pricing, "_refresh_in_progress", False)
    yield


def test_calculate_cost_never_blocks_on_slow_fetch(monkeypatch):
    """A cold cache and a slow fetch must not make calculate_cost() wait on the network."""
    def slow_urlopen(*args, **kwargs):
        time.sleep(2)
        raise TimeoutError("simulated slow network")

    monkeypatch.setattr(pricing.urllib.request, "urlopen", slow_urlopen)

    start = time.perf_counter()
    cost = pricing.calculate_cost("gpt-4o-mini", 1_000_000, 0)
    unknown_cost = pricing.calculate_cost("definitely-not-a-real-model", 100, 100)
    elapsed = time.perf_counter() - start

    assert elapsed < 0.5, f"calculate_cost() blocked the hot path for {elapsed:.2f}s"
    assert cost == pytest.approx(0.15, abs=0.001)
    assert unknown_cost == 0.0


def test_failed_refresh_after_prior_success_backs_off_full_ttl(monkeypatch):
    """A failure after an earlier success backs off for the full TTL instead of refetching on every call."""
    monkeypatch.setattr(pricing, "_cache", {"gpt-4": {}})
    monkeypatch.setattr(pricing, "_cache_ts", time.time() - pricing._CACHE_TTL - 10)

    def failing_urlopen(*args, **kwargs):
        raise TimeoutError("simulated network down")

    monkeypatch.setattr(pricing.urllib.request, "urlopen", failing_urlopen)

    fetch_attempts = 0
    orig_bg = pricing._background_fetch

    def counting_bg():
        nonlocal fetch_attempts
        fetch_attempts += 1
        orig_bg()

    monkeypatch.setattr(pricing, "_background_fetch", counting_bg)

    for _ in range(3):
        pricing._maybe_trigger_refresh()
        time.sleep(0.2)  # let the (fast, mocked) background fetch finish

    assert fetch_attempts == 1, (
        f"expected exactly 1 fetch attempt (full TTL backoff), got {fetch_attempts}"
    )
    assert not pricing._needs_refresh()


def test_only_one_background_fetch_runs_at_a_time(monkeypatch):
    """20 concurrent calls on a cold cache trigger exactly one background fetch."""
    call_count = 0
    count_lock = threading.Lock()
    release = threading.Event()

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b"{}"

    def fake_urlopen(*args, **kwargs):
        nonlocal call_count
        with count_lock:
            call_count += 1
        release.wait(timeout=5)
        return FakeResponse()

    monkeypatch.setattr(pricing.urllib.request, "urlopen", fake_urlopen)

    threads = [
        threading.Thread(target=pricing.calculate_cost, args=("gpt-4", 10, 10))
        for _ in range(20)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)  # calculate_cost() returns fast; never waits on the fetch

    release.set()
    time.sleep(0.2)  # let the single background fetch thread finish

    assert call_count == 1


def test_warm_cache_does_not_block_import_thread(monkeypatch):
    """warm_cache() kicks off the refresh without touching the network on the calling thread."""
    def slow_urlopen(*args, **kwargs):
        time.sleep(2)
        raise TimeoutError("simulated slow network")

    monkeypatch.setattr(pricing.urllib.request, "urlopen", slow_urlopen)

    start = time.perf_counter()
    pricing.warm_cache()
    elapsed = time.perf_counter() - start

    assert elapsed < 0.5


def test_live_price_overrides_bundled(monkeypatch):
    """When the live table has a model that's also bundled, live wins."""
    monkeypatch.setattr(pricing, "_cache", {
        "gpt-4o-mini": {
            "input_cost_per_token": 0.000001,
            "output_cost_per_token": 0.000001,
        }
    })
    monkeypatch.setattr(pricing, "_cache_ts", time.time())

    cost = pricing.calculate_cost("gpt-4o-mini", 1_000_000, 0)
    # Live price ($1/M), not the bundled snapshot price ($0.15/M).
    assert cost == pytest.approx(1.0, abs=0.001)


def test_custom_price_overrides_bundled(monkeypatch):
    """set_model_pricing() must win over the bundled snapshot too."""
    monkeypatch.setattr(pricing, "_CUSTOM", {})
    pricing.set_model_pricing("gpt-4o-mini", input_per_million=2.0, output_per_million=2.0)
    try:
        cost = pricing.calculate_cost("gpt-4o-mini", 1_000_000, 0)
        assert cost == pytest.approx(2.0, abs=0.001)
    finally:
        pricing._CUSTOM.pop("gpt-4o-mini", None)
