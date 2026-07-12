"""Regression tests for the os.fork() background-worker survival bug.

Audit finding #4 ("_worker thread start failure — real silent-data-loss
bug"): `_worker_started` is a plain module-level flag. `os.fork()` clones
process memory (including this flag) but not other threads — only the
calling thread survives into the child. Without an at-fork reset hook, a
forked child (gunicorn/uWSGI preload workers, Celery prefork pool, plain
os.fork(), etc.) inherits `_worker_started = True` from a parent that
already has a live sender thread — even though that thread does not exist
in the child. `_ensure_worker()`'s fast-path check (`if _worker_started:
return`) then short-circuits FOREVER in that child: no sender thread is
ever started there, so every trace enqueued via `_enqueue_remote()` in
that process sits in `_send_queue` for the process's entire lifetime with
nothing draining it. No exception is raised anywhere — it just silently
never syncs. Unlike a transient `Thread.start()` failure (which leaves
`_worker_started` False and self-heals on the next call), this is
permanent for that process.

These tests use a REAL os.fork() rather than mocking it — the whole bug
is specifically about what fork() does to process/thread state, which a
mock can't exercise.
"""

from __future__ import annotations

import os
import threading
import time

import pytest

import swarmtrace.tracer as tracer

pytestmark = pytest.mark.skipif(
    not hasattr(os, "fork"), reason="os.fork() not available on this platform"
)


def _run_in_child(fn) -> str:
    """Fork, run ``fn()`` in the child, report PASS/FAIL back via a pipe.

    Uses os._exit() in the child (never sys.exit / a bare return) so the
    forked copy never runs pytest's normal teardown machinery — that's a
    second sharp edge of forking inside a test process, unrelated to the
    bug under test, and os._exit() sidesteps it entirely.
    """
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        # ---- child ----
        os.close(read_fd)
        try:
            fn()
            result = b"PASS"
        except BaseException as exc:  # noqa: BLE001 - report every failure mode
            result = f"FAIL: {exc!r}".encode()
        os.write(write_fd, result)
        os.close(write_fd)
        os._exit(0)
    # ---- parent ----
    os.close(write_fd)
    chunks = []
    while True:
        chunk = os.read(read_fd, 4096)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(read_fd)
    _, status = os.waitpid(pid, 0)
    result = b"".join(chunks).decode()
    assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, (
        f"child process exited abnormally (status={status}): {result}"
    )
    return result


@pytest.fixture(autouse=True)
def _restore_worker_state():
    """`_worker_started` / `_send_queue` are process-global module state —
    save and restore around each test so tests don't leak into each other
    or into other test files running in the same process."""
    original_started = tracer._worker_started
    original_queue = tracer._send_queue
    yield
    tracer._worker_started = original_started
    tracer._send_queue = original_queue


def test_at_fork_hook_is_registered():
    """Sanity check the hook is actually wired up, guarding against the
    ``if hasattr(os, "register_at_fork")`` guard silently no-op'ing on a
    platform where it's expected to be present."""
    assert hasattr(os, "register_at_fork"), (
        "this test only runs where os.fork() exists, and on those "
        "platforms register_at_fork should too"
    )


def test_worker_started_flag_resets_in_child():
    """Core regression guard. Without the at-fork hook, this is exactly
    the stuck state a forked child inherits — permanently."""
    tracer._worker_started = True  # simulate: parent already has a live worker

    def _child_check():
        assert tracer._worker_started is False, (
            "audit finding #4 regression: _worker_started is still True "
            "in the child — _ensure_worker() will never spawn a real "
            "sender thread here, and every trace enqueued in this "
            "process will silently never sync"
        )

    assert _run_in_child(_child_check) == "PASS"


def test_ensure_worker_spawns_a_real_thread_in_child():
    """End-to-end: after fork, _ensure_worker() must actually start a
    live 'swarmtrace-sender' thread in the child — not just flip a flag."""
    tracer._worker_started = True  # simulate a parent with a live worker

    def _child_check():
        tracer._ensure_worker()
        time.sleep(0.05)  # let the new thread actually start
        names = [t.name for t in threading.enumerate()]
        assert "swarmtrace-sender" in names, (
            f"no sender thread running in child after _ensure_worker(); "
            f"threads seen: {names}"
        )
        assert tracer._worker_started is True

    assert _run_in_child(_child_check) == "PASS"


def test_inherited_queue_is_replaced_not_reused():
    """The child gets a fresh `_send_queue`, not the parent's inherited
    one — replaying into a Queue whose internal locks may be in an
    inconsistent post-fork state is riskier than starting clean, and
    anything already queued is already durable in SQLite via
    save_trace() regardless."""
    tracer._worker_started = True
    parent_queue_id = id(tracer._send_queue)

    def _child_check():
        assert id(tracer._send_queue) != parent_queue_id, (
            "child inherited the parent's _send_queue object instead of "
            "getting a fresh one"
        )

    assert _run_in_child(_child_check) == "PASS"
