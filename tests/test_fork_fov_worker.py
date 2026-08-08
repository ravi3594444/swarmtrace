"""Regression tests for the os.fork() FOV-worker survival bug.

Same bug as audit finding #4 (tracer.py's `_worker_started`), applied to
`swarmtrace/fov.py`'s `_fov_worker_started` flag: `os.fork()` clones
process memory (including the flag) but not other threads -- only the
calling thread survives into the child. Without an at-fork reset hook, a
forked child inherits `_fov_worker_started = True` from a parent with a
live FOV sender thread that does not exist in the child, so
`_ensure_fov_worker()`'s fast-path check short-circuits forever there --
no sender thread ever starts, and every FOV event enqueued in that
process sits in `_FOV_QUEUE` with nothing draining it.

Mirrors tests/test_fork_worker.py -- see that file for the fuller
writeup of why these use a REAL os.fork() instead of mocking it.
"""

from __future__ import annotations

import os
import threading
import time

import pytest

from swarmtrace import fov

pytestmark = pytest.mark.skipif(
    not hasattr(os, "fork"), reason="os.fork() not available on this platform"
)


def _run_in_child(fn) -> str:
    """Fork, run ``fn()`` in the child, report PASS/FAIL back via a pipe.

    Uses os._exit() in the child so the forked copy never runs pytest's
    normal teardown machinery.
    """
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        # ---- child ----
        os.close(read_fd)
        try:
            fn()
            result = b"PASS"
        except BaseException as exc:
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
def _restore_fov_worker_state():
    """`_fov_worker_started` / `_FOV_QUEUE` are process-global module
    state -- save and restore around each test."""
    original_started = fov._fov_worker_started
    original_queue = fov._FOV_QUEUE
    yield
    fov._fov_worker_started = original_started
    fov._FOV_QUEUE = original_queue


def test_at_fork_hook_is_registered():
    assert hasattr(os, "register_at_fork"), (
        "this test only runs where os.fork() exists, and on those "
        "platforms register_at_fork should too"
    )


def test_fov_worker_started_flag_resets_in_child():
    """Core regression guard. Without the at-fork hook, this is exactly
    the stuck state a forked child inherits -- permanently."""
    fov._fov_worker_started = True  # simulate: parent already has a live worker

    def _child_check():
        assert fov._fov_worker_started is False, (
            "fov.py fork-survival regression: _fov_worker_started is "
            "still True in the child -- _ensure_fov_worker() will never "
            "spawn a real sender thread here, and every FOV event "
            "enqueued in this process will silently never sync"
        )

    assert _run_in_child(_child_check) == "PASS"


def test_ensure_fov_worker_spawns_a_real_thread_in_child():
    """End-to-end: after fork, _ensure_fov_worker() must actually start a
    live 'swarmtrace-fov-sender' thread in the child -- not just flip a
    flag."""
    fov._fov_worker_started = True  # simulate a parent with a live worker

    def _child_check():
        fov._ensure_fov_worker()
        time.sleep(0.05)  # let the new thread actually start
        names = [t.name for t in threading.enumerate()]
        assert "swarmtrace-fov-sender" in names, (
            f"no FOV sender thread running in child after "
            f"_ensure_fov_worker(); threads seen: {names}"
        )
        assert fov._fov_worker_started is True

    assert _run_in_child(_child_check) == "PASS"


def test_fov_inherited_queue_is_replaced_not_reused():
    """The child gets a fresh `_FOV_QUEUE`, not the parent's inherited
    one."""
    fov._fov_worker_started = True
    parent_queue_id = id(fov._FOV_QUEUE)

    def _child_check():
        assert id(fov._FOV_QUEUE) != parent_queue_id, (
            "child inherited the parent's _FOV_QUEUE object instead of "
            "getting a fresh one"
        )

    assert _run_in_child(_child_check) == "PASS"


def test_fov_queue_maxsize_survives_reset():
    """The fresh post-fork queue keeps the same maxsize as the original
    (regression guard for the maxsize being hardcoded twice and drifting)."""
    fov._fov_worker_started = True

    def _child_check():
        assert fov._FOV_QUEUE.maxsize == fov._FOV_QUEUE_MAX

    assert _run_in_child(_child_check) == "PASS"
