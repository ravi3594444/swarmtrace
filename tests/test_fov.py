"""Regression test for the fov.py screen-streamer thread-start race.

Bug: _ensure_screen_streamer() checked-then-set _screen_streamer_started
with no lock, so concurrent first calls (e.g. two agents opening Playwright
pages at once — the exact "swarm" scenario this product is for) could each
pass the check before either set the flag, spawning duplicate background
screenshot threads forever. tracer._ensure_worker and fov._ensure_fov_worker
already used correct double-checked locking; this call site didn't.

Fix: _ensure_screen_streamer() now uses the same double-checked locking
pattern with a dedicated _screen_streamer_lock.
"""

import threading

import pytest

from swarmtrace import fov


@pytest.fixture(autouse=True)
def reset_streamer_state(monkeypatch):
    monkeypatch.setattr(fov, "_screen_streamer_started", False)
    yield


def test_concurrent_first_calls_start_exactly_one_streamer_thread(monkeypatch):
    release = threading.Event()

    def fake_loop():
        # Stand-in for the real infinite loop: blocks so the thread stays
        # alive long enough to count, then exits cleanly on release.
        release.wait(timeout=5)

    monkeypatch.setattr(fov, "_screen_streamer_loop", fake_loop)

    n = 20
    barrier = threading.Barrier(n)

    def call_ensure():
        barrier.wait()  # line everyone up to hit _ensure_screen_streamer() together
        fov._ensure_screen_streamer()

    callers = [threading.Thread(target=call_ensure) for _ in range(n)]
    for t in callers:
        t.start()
    for t in callers:
        t.join(timeout=5)

    live = [t for t in threading.enumerate() if t.name == "swarmtrace-screen-stream"]

    release.set()
    for t in live:
        t.join(timeout=5)

    assert len(live) == 1, f"expected exactly 1 streamer thread, found {len(live)}"
    assert fov._screen_streamer_started is True


def test_already_started_short_circuits_without_lock_contention():
    """Once started, repeated calls are a no-op — just the fast-path check."""
    fov._screen_streamer_started = True
    fov._ensure_screen_streamer()  # must not raise or spawn anything
    assert fov._screen_streamer_started is True


def test_fov_worker_retries_remote_failures_three_times(monkeypatch, caplog):
    """Remote send errors must escape the sender so the worker can retry them."""
    attempts = []

    class StopWorker(BaseException):
        pass

    class OneItemQueue:
        def get(self):
            return {"event": "click"}

        def task_done(self):
            raise StopWorker

    def fail_send(*args):
        attempts.append(args)
        raise OSError("network unavailable")

    monkeypatch.setattr(fov, "_FOV_QUEUE", OneItemQueue())
    monkeypatch.setattr(fov, "_remote_config", lambda: ("key", "https://example.com/api"))
    monkeypatch.setattr(fov, "_send_event_remote", fail_send)
    monkeypatch.setattr(fov.time, "sleep", lambda _delay: None)

    with pytest.raises(StopWorker):
        fov._fov_worker()

    assert len(attempts) == 3
    assert attempts[0][2] == "https://example.com"
    assert "failed after 3 attempts" in caplog.text
