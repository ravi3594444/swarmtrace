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

import sqlite3
import threading
import time

import pytest

from swarmtrace import fov, storage


@pytest.fixture(autouse=True)
def reset_events_table_state(monkeypatch):
    # None = "not created in any database yet", the cache's cold state.
    monkeypatch.setattr(fov, "_events_table_ready_conn", None)
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
    assert fov._events_table_ready_conn is not None


def test_already_ready_short_circuits_without_re_running_the_ddl(monkeypatch):
    """Once the live connection is marked ready, the DDL must not run again."""
    conn = storage._get_conn()
    monkeypatch.setattr(fov, "_events_table_ready_conn", conn)

    executed = []
    conn.set_trace_callback(executed.append)
    try:
        fov._ensure_events_table()
    finally:
        conn.set_trace_callback(None)

    assert not [q for q in executed if "CREATE" in q.upper()], executed
    assert fov._events_table_ready_conn is conn


def test_rotating_the_database_recreates_the_table(tmp_path, monkeypatch):
    """A rotated database must get its own agent_events table.

    Three cache designs failed here in turn. A plain boolean latched True
    forever. Keying on ``storage.DB_PATH`` looked right but was not sound:
    ``_get_conn()`` only reopens when the connection is gone or unhealthy, so
    it can hand back a connection still attached to the OLD file while this
    cache records the NEW path as ready — the DDL lands in the wrong database
    and every later event is lost to a swallowed "no such table" warning. The
    key has to be the connection itself.

    This covers the interleaving FOV actually produces: a background tick
    (screen streamer, watchdog, patched HTTP call) landing between the path
    swap and the close.
    """
    def _event(event_id: str) -> dict:
        return {
            "id": event_id, "agent_id": "a1", "agent_name": "AgentOne",
            "event_type": "http", "status": "info", "data": "{}",
            "timestamp": "2026-01-01T00:00:00+00:00",
        }

    monkeypatch.setattr(storage, "DB_PATH", str(tmp_path / "first.db"))
    storage.close()
    fov._save_event_local(_event("e1"))
    assert len(fov.get_events("a1")) == 1

    # Rotate WITHOUT closing first, then let a tick land before the close.
    # This is the ordering the path-keyed cache got wrong.
    monkeypatch.setattr(storage, "DB_PATH", str(tmp_path / "second.db"))
    fov._save_event_local(_event("e2"))
    storage.close()
    fov._save_event_local(_event("e3"))

    assert len(fov.get_events("a1")) >= 1, (
        "events lost after rotating the database — agent_events was never "
        "created in the new file"
    )
    rotated = sqlite3.connect(str(tmp_path / "second.db"))
    try:
        tables = {r[0] for r in rotated.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        rotated.close()
    assert "agent_events" in tables, f"second.db never got the table: {tables}"
    storage.close()
