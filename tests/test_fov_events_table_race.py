"""Regression test for the fov.py agent_events-table creation race.

Audit finding #11 ("fov.py TOCTOU race"). _ensure_events_table() used to
be a naive check-then-act with no recheck inside the lock, and the ready
flag was set AFTER releasing the lock:

    if _events_table_ready: return
    with _storage_lock:
        conn.execute("CREATE TABLE IF NOT EXISTS ...")
        ...
    _events_table_ready = True   # set OUTSIDE the lock

Concurrent first callers (a realistic case: several traced browser pages
registering near-simultaneously at startup, each triggering a FOV event
save) would each pass the unlocked check before any of them set the
flag, then each redundantly re-run the CREATE TABLE/INDEX statements
once they got the lock. This is exactly the same TOCTOU shape already
fixed elsewhere in this file for _ensure_fov_worker (see
test_fork_fov_worker.py) and _ensure_screen_streamer (see
test_fov.py) — this call site was the one left behind.

Fix: _ensure_events_table() now uses the same double-checked locking
pattern with a dedicated _events_table_lock: recheck the flag after
acquiring the lock, and set it while still holding that lock.
"""

from __future__ import annotations

import threading
import time

import pytest

from swarmtrace import fov


@pytest.fixture(autouse=True)
def reset_events_table_state(monkeypatch):
    # None = "not created in any database yet", the cache's cold state.
    monkeypatch.setattr(fov, "_events_table_ready_for", None)
    yield


def test_concurrent_first_calls_create_the_table_exactly_once(monkeypatch):
    """20 threads all calling _ensure_events_table() for the very first
    time, simultaneously, must result in exactly ONE execution of the
    CREATE TABLE / CREATE INDEX statements — not one per thread.

    The fake conn's first CREATE TABLE call deliberately sleeps briefly
    to hold the critical section open. Real SQLite calls do actual disk
    I/O (which releases the GIL), giving other threads a natural chance
    to interleave; an instant in-memory stand-in doesn't reproduce that
    window on its own, so this sleep stands in for it — without it, this
    test doesn't reliably catch the bug even when reverted (verified: 20
    threads finished within a single GIL timeslice often enough that the
    unfixed code still only paid the DDL cost once or twice per run,
    making the test flaky-green on the very bug it's meant to catch).
    """

    ddl_calls = []
    commit_calls = []
    first_ddl_started = threading.Event()

    class _FakeConn:
        def execute(self, sql, *args):
            if "CREATE TABLE" in sql:
                first_ddl_started.set()
                time.sleep(0.1)  # hold the critical section open
            if "CREATE TABLE" in sql or "CREATE INDEX" in sql:
                ddl_calls.append(sql)

        def commit(self):
            commit_calls.append(True)

    fake_conn = _FakeConn()
    monkeypatch.setattr(fov, "_get_conn", lambda: fake_conn)

    n = 20
    barrier = threading.Barrier(n)

    def call_ensure():
        barrier.wait()  # line everyone up to hit _ensure_events_table() together
        fov._ensure_events_table()

    callers = [threading.Thread(target=call_ensure) for _ in range(n)]
    for t in callers:
        t.start()
    for t in callers:
        t.join(timeout=5)

    assert first_ddl_started.is_set(), "test setup: DDL never ran at all"
    assert len(ddl_calls) == 2, (
        f"expected exactly 2 DDL statements (1 CREATE TABLE + 1 CREATE "
        f"INDEX), got {len(ddl_calls)}: {ddl_calls}"
    )
    assert len(commit_calls) == 1, (
        f"expected exactly 1 commit, got {len(commit_calls)} — the table "
        f"setup should only run once even under concurrent first calls"
    )
    assert fov._events_table_ready_for == fov._storage.DB_PATH


def test_already_ready_short_circuits_without_touching_storage(monkeypatch):
    """Once the current DB is marked ready, repeated calls must not touch
    storage at all — pure fast-path check."""
    monkeypatch.setattr(fov, "_events_table_ready_for", fov._storage.DB_PATH)

    def _boom():
        raise AssertionError("_get_conn() should not be called on the fast path")

    monkeypatch.setattr(fov, "_get_conn", _boom)
    fov._ensure_events_table()  # must not raise
    assert fov._events_table_ready_for == fov._storage.DB_PATH


def test_rotating_the_database_recreates_the_table(tmp_path, monkeypatch):
    """The cache must not survive a DB_PATH rotation.

    storage.close() documents rotating the database as supported. While this
    cache was a plain boolean it latched True forever, so agent_events was
    never created in the second database and every insert failed with
    "no such table: agent_events" — swallowed as a warning, events silently
    lost.
    """
    def _event(event_id: str) -> dict:
        return {
            "id": event_id, "agent_id": "a1", "agent_name": "AgentOne",
            "event_type": "http", "status": "info", "data": "{}",
            "timestamp": "2026-01-01T00:00:00+00:00",
        }

    monkeypatch.setattr(fov._storage, "DB_PATH", str(tmp_path / "first.db"))
    fov._storage.close()
    fov._save_event_local(_event("e1"))
    assert len(fov.get_events("a1")) == 1

    # Exactly what storage.close()'s docstring says is supported.
    fov._storage.close()
    monkeypatch.setattr(fov._storage, "DB_PATH", str(tmp_path / "second.db"))

    fov._save_event_local(_event("e2"))
    assert len(fov.get_events("a1")) == 1, (
        "event lost after rotating the database — agent_events was never "
        "created in the new file"
    )
    fov._storage.close()
