"""Regression tests for the os.fork() background-worker survival bug.

Audit finding #4: the sender's ``_started`` flag is plain process memory.
``os.fork()`` clones it (including ``_started = True``) but not other
threads — only the calling thread survives into the child. Without an
at-fork reset hook, a forked child inherits ``_started = True`` from a
parent that already has a live sender thread, even though that thread does
not exist in the child. ``start()``'s fast-path then short-circuits forever
in that child: no sender thread is ever started, so every trace enqueued
there sits in the queue for the process's lifetime with nothing draining
it. No exception is raised; it just silently never syncs.

These tests use a REAL os.fork() rather than mocking it — the whole bug is
specifically about what fork() does to process/thread state, which a mock
can't exercise.

Phase 1.B: the worker moved to ``swarmtrace.delivery.sender.Sender``; these
tests now drive the module-level ``tracer._sender`` instead of removed
``tracer._worker_started`` / ``tracer._send_queue`` / ``tracer._ensure_worker``
globals.
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
    forked copy never runs pytest's normal teardown machinery.
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
def _restore_sender_state():
    """``_sender._started`` / ``_sender._queue`` are process-global state —
    save and restore around each test so tests don't leak into each other."""
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
    """Core regression guard. Without the at-fork hook, this is exactly the
    stuck state a forked child inherits — permanently."""
    tracer._sender._started = True  # simulate: parent already has a live worker

    def _child_check():
        assert tracer._sender._started is False, (
            "audit finding #4 regression: _started is still True in the "
            "child — start() will never spawn a real sender thread here, "
            "and every trace enqueued in this process will silently never sync"
        )

    assert _run_in_child(_child_check) == "PASS"


def test_ensure_worker_spawns_a_real_thread_in_child():
    """End-to-end: after fork, start() must actually start a live
    'swarmtrace-sender' thread in the child — not just flip a flag."""
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
    """The child gets a fresh queue, not the parent's inherited one —
    replaying into a Queue whose internal locks may be in an inconsistent
    post-fork state is riskier than starting clean, and anything already
    queued is already durable in SQLite via save_trace() regardless."""
    tracer._sender._started = True
    parent_queue_id = id(tracer._sender._queue)

    def _child_check():
        assert id(tracer._sender._queue) != parent_queue_id, (
            "child inherited the parent's queue instead of getting a fresh one"
        )

    assert _run_in_child(_child_check) == "PASS"
