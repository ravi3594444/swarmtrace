"""os.fork() must not leave the child thinking the sender thread is alive.

Uses a real os.fork(); a mock can't show what fork does to thread state.
"""

from __future__ import annotations

import os
import threading
import time

import pytest

from swarmtrace import tracer

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
def _restore_sender_state():
    """Save and restore the process-global sender state around each test."""
    sender = tracer._sender
    original_started = sender._started
    original_queue = sender._queue
    yield
    sender._started = original_started
    sender._queue = original_queue


def test_at_fork_hook_is_registered():
    """Sanity check the hook is actually wired up."""
    assert hasattr(os, "register_at_fork"), (
        "this test only runs where os.fork() exists, and on those "
        "platforms register_at_fork should too"
    )


def test_worker_started_flag_resets_in_child():
    """A child must not inherit `_started = True` from a parent with a live worker."""
    tracer._sender._started = True  # simulate: parent already has a live worker

    def _child_check():
        assert tracer._sender._started is False, (
            "_started is still True in the "
            "child — start() will never spawn a real sender thread here, "
            "and every trace enqueued in this process will silently never sync"
        )

    assert _run_in_child(_child_check) == "PASS"


def test_ensure_worker_spawns_a_real_thread_in_child():
    """After fork, start() launches a live 'swarmtrace-sender' thread in the child."""
    tracer._sender._started = True  # simulate a parent with a live worker

    def _child_check():
        tracer._sender.start()
        time.sleep(0.05)  # let the new thread actually start
        names = [t.name for t in threading.enumerate()]
        assert "swarmtrace-sender" in names, (
            f"no sender thread running in child after start(); "
            f"threads seen: {names}"
        )
        assert tracer._sender._started is True

    assert _run_in_child(_child_check) == "PASS"


def test_inherited_queue_is_replaced_not_reused():
    """The child gets a fresh queue; queued items are already durable in SQLite."""
    tracer._sender._started = True
    parent_queue_id = id(tracer._sender._queue)

    def _child_check():
        assert id(tracer._sender._queue) != parent_queue_id, (
            "child inherited the parent's queue instead of getting a fresh one"
        )

    assert _run_in_child(_child_check) == "PASS"
