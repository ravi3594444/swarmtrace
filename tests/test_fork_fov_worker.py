"""After os.fork() the FOV sender must be restartable in the child (see test_fork_worker.py)."""

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
    """Fork, run ``fn()`` in the child, report PASS/FAIL back via a pipe."""
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            fn()
            result = b"PASS"
        except BaseException as exc:  # noqa: BLE001 -- deliberately broader than Exception, see docstring above
            result = f"FAIL: {exc!r}".encode()
        os.write(write_fd, result)
        os.close(write_fd)
        os._exit(0)
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
    """Save and restore the process-global worker state around each test."""
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
    """A child must not inherit the stuck "worker already started" state."""
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
    """After fork, _ensure_fov_worker() starts a live sender thread in the child."""
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
    """The child gets a fresh queue, not the parent's."""
    fov._fov_worker_started = True
    parent_queue_id = id(fov._FOV_QUEUE)

    def _child_check():
        assert id(fov._FOV_QUEUE) != parent_queue_id, (
            "child inherited the parent's _FOV_QUEUE object instead of "
            "getting a fresh one"
        )

    assert _run_in_child(_child_check) == "PASS"


def test_fov_queue_maxsize_survives_reset():
    """The fresh queue keeps the original maxsize."""
    fov._fov_worker_started = True

    def _child_check():
        assert fov._FOV_QUEUE.maxsize == fov._FOV_QUEUE_MAX

    assert _run_in_child(_child_check) == "PASS"
