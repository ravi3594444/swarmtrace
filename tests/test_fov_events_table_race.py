"""Concurrent first calls to _ensure_events_table must create the table once."""

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
    """20 threads racing the first _ensure_events_table() call run the DDL exactly once.

    The fake conn sleeps on the first CREATE TABLE to hold the critical section
    open; an instant stand-in wouldn't reproduce the window.
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
    """Once ready, repeated calls don't touch storage."""
    monkeypatch.setattr(fov, "_events_table_ready_for", fov._storage.DB_PATH)

    def _boom():
        raise AssertionError("_get_conn() should not be called on the fast path")

    monkeypatch.setattr(fov, "_get_conn", _boom)
    fov._ensure_events_table()  # must not raise
    assert fov._events_table_ready_for == fov._storage.DB_PATH


def test_rotating_the_database_recreates_the_table(tmp_path, monkeypatch):
    """The ready cache must not survive a DB_PATH rotation, or the new DB never gets agent_events."""
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
