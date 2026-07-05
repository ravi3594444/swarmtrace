"""Regression tests for the pricing.py hot-path-blocking bug.

Bug: calculate_cost() (called inline from tracer._extract_token_info and
auto_instrument._record_async, both on the calling/hot-path thread) used to
call _fetch_live(), which could itself perform a synchronous, up-to-5s
network fetch while holding _cache_lock. Any traced call racing the hourly
TTL expiry — or the very first call right after import — would block the
agent's thread on real network I/O, contradicting the documented
"never on the agent's hot path" guarantee.

Fix: the cache is only ever read inline; refreshes are dispatched to a
dedicated background thread, deduplicated so at most one fetch is ever in
flight at a time.
"""

import threading
import time

import pytest

import swarmtrace.pricing as pricing


@pytest.fixture(autouse=True)
def reset_pricing_state(monkeypatch):
    """Clean cache/refresh state per test, and wait out any leftover
    warm_cache() thread from module import so it can't race a test's own
    mocked fetch.
    """
    for t in threading.enumerate():
        if t.name in ("swarmtrace-pricing-warm", "swarmtrace-pricing-refresh") and t.is_alive():
            t.join(timeout=5)
    monkeypatch.setattr(pricing, "_cache", {})
    monkeypatch.setattr(pricing, "_cache_ts", 0.0)
    monkeypatch.setattr(pricing, "_refresh_in_progress", False)
    yield


def test_calculate_cost_never_blocks_on_slow_fetch(monkeypatch):
    """The hot-path call must return almost instantly even with a cold
    cache and a slow underlying fetch — it must never wait on the network.
    """
    def slow_urlopen(*args, **kwargs):
        time.sleep(2)
        raise TimeoutError("simulated slow network")

    monkeypatch.setattr(pricing.urllib.request, "urlopen", slow_urlopen)

    start = time.perf_counter()
    cost = pricing.calculate_cost("gpt-4", 100, 100)
    elapsed = time.perf_counter() - start

    assert elapsed < 0.5, f"calculate_cost() blocked the hot path for {elapsed:.2f}s"
    assert cost == 0.0  # cache still empty while the background fetch is in flight


def test_failed_refresh_after_prior_success_backs_off_full_ttl(monkeypatch):
    """A fetch failing *after* an earlier success must back off for the full
    TTL, not retry on every subsequent hot-path call.

    Regression test for a bug found during self-review: the except branch
    only updated _cache_ts if it was still 0.0 (never-succeeded), so once a
    real fetch had ever succeeded, later failures left _cache_ts stale and
    every hot-path call re-triggered a new background fetch indefinitely.
    """
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
    """20 concurrent hot-path calls against a cold cache must trigger
    exactly one background fetch, not a thundering herd.
    """
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
    """warm_cache() (called at module import time) must trigger the refresh
    without itself ever touching the network on the calling thread.
    """
    def slow_urlopen(*args, **kwargs):
        time.sleep(2)
        raise TimeoutError("simulated slow network")

    monkeypatch.setattr(pricing.urllib.request, "urlopen", slow_urlopen)

    start = time.perf_counter()
    pricing.warm_cache()
    elapsed = time.perf_counter() - start

    assert elapsed < 0.5
