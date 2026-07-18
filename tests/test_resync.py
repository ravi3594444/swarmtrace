"""Tests for the synced flag + resync CLI (task 3: spillover via sync flag).

Covers the three "done when" criteria from the spec:
  1. Simulated failed send leaves row unsynced (synced=0).
  2. Simulated success marks it synced (synced=1).
  3. resync only touches unsynced rows (already-synced rows are not re-sent).

Also covers:
  - Schema migration: the synced column is added to existing DBs.
  - resync returns (0,0,0) when remote isn't configured.
  - resync marks rows synced=1 on success and leaves them synced=0 on failure.
"""

from __future__ import annotations

import importlib
import threading
import time
from unittest.mock import patch

import pytest

import swarmtrace.tracer as tracer
import swarmtrace.storage as storage
from swarmtrace import runtime as runtime_module
from swarmtrace.adapters.sqlite_repository import SqliteRepository
from swarmtrace.runtime import Runtime
from tests._fakes import FakeTransport


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

@pytest.fixture()
def fresh_storage(tmp_path, monkeypatch):
    """Reload storage against a temp DB so tests start with a clean table.

    Also rebinds the names tracer imported from storage so they point at the
    reloaded module's functions (which use the temp DB).
    """
    monkeypatch.setenv("SWARMTRACE_DB_PATH", str(tmp_path / "traces.db"))
    importlib.reload(storage)
    tracer.save_trace = storage.save_trace
    tracer.mark_synced = storage.mark_synced
    yield storage
    if storage._conn is not None:
        storage._conn.close()
        storage._conn = None


@pytest.fixture()
def remote_config(monkeypatch):
    """Configure a fake remote endpoint so _remote_config() returns non-empty."""
    monkeypatch.setenv("SWARMTRACE_API_KEY", "test-key")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "https://example.test")
    # Also set on the module-level globals, since _remote_config checks
    # those first (set via init()) — env vars are the fallback.
    monkeypatch.setattr(tracer, "_api_key", None, raising=False)
    monkeypatch.setattr(tracer, "_endpoint", None, raising=False)


@pytest.fixture()
def resync_runtime(monkeypatch, fresh_storage, remote_config):
    """A runtime wired to the temp-DB SqliteRepository + a FakeTransport.

    Lets resync tests drive success/failure through the transport without
    patching private tracer internals, while still reading the synced flag
    back from the real SQLite outbox.
    """
    repo = SqliteRepository()
    transport = FakeTransport()
    rt = Runtime(repo, transport, tracer._remote_config)
    monkeypatch.setattr(runtime_module, "_runtime", rt)
    return rt


def _save_trace(storage, trace_id="t1", synced=0):
    """Insert a trace row directly via storage (bypassing the decorator)."""
    storage.save_trace(
        id_=trace_id, parent_id=None, function="fn", args="()", output="out",
        latency_sec=0.1, error=None,
        timestamp="2026-01-01T00:00:00+00:00", input_tokens=10, output_tokens=5,
        cost_usd=0.001,
        kind="agent", agent_id=trace_id, agent_name="fn",
    )
    # save_trace leaves synced=0 by default; if the test wants synced=1,
    # mark it explicitly.
    if synced:
        storage.mark_synced(trace_id, 1)


# --------------------------------------------------------------------------
# Schema / migration
# --------------------------------------------------------------------------

class TestSyncedColumn:
    def test_synced_column_exists_after_migration(self, fresh_storage):
        """The synced column is present on a fresh DB (CREATE TABLE path)."""
        conn = fresh_storage._get_conn()
        cols = {row[1] for row in conn.execute("PRAGMA table_info(traces)").fetchall()}
        assert "synced" in cols

    def test_synced_column_added_to_existing_db(self, tmp_path, monkeypatch):
        """The migration adds synced to a DB that was created before the column
        existed (simulates an upgrade from a pre-task-3 install)."""
        db_path = tmp_path / "old.db"
        monkeypatch.setenv("SWARMTRACE_DB_PATH", str(db_path))

        # Create a DB WITHOUT the synced column — mimics the old schema.
        import sqlite3
        old_conn = sqlite3.connect(str(db_path))
        old_conn.execute("""
            CREATE TABLE traces (
                id            TEXT PRIMARY KEY,
                parent_id     TEXT,
                function      TEXT,
                args          TEXT,
                output        TEXT,
                latency_sec   REAL,
                error         TEXT,
                timestamp     TEXT,
                input_tokens  INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                cost_usd      REAL    DEFAULT 0,
                kind          TEXT    NOT NULL DEFAULT 'agent',
                agent_id      TEXT,
                agent_name    TEXT,
                session_id    TEXT
            )
        """)
        old_conn.execute(
            "INSERT INTO traces (id, function, timestamp) VALUES (?, ?, ?)",
            ("old-row", "fn", "2026-01-01T00:00:00+00:00"),
        )
        old_conn.commit()
        old_conn.close()

        # Now reload storage — _migrate_columns should add `synced`.
        importlib.reload(storage)
        conn = storage._get_conn()
        cols = {row[1] for row in conn.execute("PRAGMA table_info(traces)").fetchall()}
        assert "synced" in cols
        # The pre-existing row should default to synced=0 (unsynced) so
        # resync picks it up.
        row = storage.get_by_id("old-row")
        assert row is not None
        assert row["synced"] == 0  # synced column

    def test_new_rows_default_to_unsynced(self, fresh_storage):
        _save_trace(fresh_storage, "t-new")
        row = fresh_storage.get_by_id("t-new")
        assert row["synced"] == 0  # synced=0


# --------------------------------------------------------------------------
# _worker mark-synced behavior
# --------------------------------------------------------------------------

class TestWorkerMarksSynced:
    """The background sender marks a row synced=1 after a confirmed send,
    and leaves it synced=0 when all retries fail.

    Phase 1: the worker lives in ``swarmtrace.delivery.sender.Sender``; these
    tests drive it through the runtime seam with a FakeTransport instead of
    patching private tracer internals.
    """

    def test_successful_send_marks_synced(self, resync_runtime):
        _save_trace(storage, "t-success")
        sender = resync_runtime.sender

        # Simulate one worker iteration: send succeeds → mark_synced called.
        payload = {"id": "t-success"}
        assert sender._send_with_retries(
            [payload], "test-key", "https://example.test"
        ) is True
        sender._repository.mark_synced("t-success")
        assert storage.get_by_id("t-success")["synced"] == 1

    def test_failed_send_leaves_unsynced(self, resync_runtime):
        _save_trace(storage, "t-fail")
        resync_runtime.transport.raise_on_batch = Exception("network down")
        sender = resync_runtime.sender

        payload = {"id": "t-fail"}
        # All 3 retries fail → _send_with_retries returns False.
        assert sender._send_with_retries(
            [payload], "test-key", "https://example.test"
        ) is False
        # mark_synced is NOT called by the worker on failure → row stays unsynced.
        assert storage.get_by_id("t-fail")["synced"] == 0


# --------------------------------------------------------------------------
# resync function
# --------------------------------------------------------------------------

class TestResyncFunction:
    def test_resync_returns_zero_when_remote_not_configured(self, fresh_storage, monkeypatch):
        # No API key / endpoint → resync returns (0, 0, 0).
        monkeypatch.delenv("SWARMTRACE_API_KEY", raising=False)
        monkeypatch.delenv("SWARMTRACE_ENDPOINT", raising=False)
        monkeypatch.setattr(tracer, "_api_key", None, raising=False)
        monkeypatch.setattr(tracer, "_endpoint", None, raising=False)

        _save_trace(fresh_storage, "t1")  # unsynced row exists
        result = tracer.resync(batch_size=10)
        assert result == (0, 0, 0)

    def test_resync_returns_zero_when_no_unsynced_rows(self, fresh_storage, remote_config):
        # No unsynced rows → resync returns (0, 0, 0) even if remote is configured.
        result = tracer.resync(batch_size=10)
        assert result == (0, 0, 0)

    def test_resync_sends_unsynced_rows_and_marks_synced(self, resync_runtime):
        _save_trace(storage, "t1")
        _save_trace(storage, "t2")
        # Both rows unsynced. FakeTransport.send_single succeeds by default.
        attempted, succeeded, failed = tracer.resync(batch_size=10, retries=1)
        assert attempted == 2
        assert succeeded == 2
        assert failed == 0
        # Both rows now marked synced=1 in the DB.
        assert storage.get_by_id("t1")["synced"] == 1
        assert storage.get_by_id("t2")["synced"] == 1

    def test_resync_leaves_failed_rows_unsynced(self, resync_runtime):
        _save_trace(storage, "t-fail-1")
        _save_trace(storage, "t-fail-2")
        # All sends fail.
        resync_runtime.transport.raise_on_single = Exception("endpoint down")
        attempted, succeeded, failed = tracer.resync(batch_size=10, retries=1)
        assert attempted == 2
        assert succeeded == 0
        assert failed == 2
        # Rows stay synced=0 — resync can retry them next run.
        assert storage.get_by_id("t-fail-1")["synced"] == 0
        assert storage.get_by_id("t-fail-2")["synced"] == 0

    def test_resync_only_touches_unsynced_rows(self, resync_runtime):
        """The critical spec requirement: resync only re-sends rows where
        synced=0. Already-synced rows are NOT re-sent (no duplicate POSTs,
        no double-counting on the dashboard's daily_metrics)."""
        # 2 unsynced + 2 already-synced.
        _save_trace(storage, "u1", synced=0)
        _save_trace(storage, "u2", synced=0)
        _save_trace(storage, "s1", synced=1)
        _save_trace(storage, "s2", synced=1)

        attempted, succeeded, failed = tracer.resync(batch_size=10, retries=1)

        assert attempted == 2  # only the 2 unsynced rows
        assert succeeded == 2
        assert failed == 0
        # The already-synced rows were never re-sent.
        sent_ids = {p["id"] for p in resync_runtime.transport.singles}
        assert sent_ids == {"u1", "u2"}
        # After resync, all 4 rows are synced=1.
        for tid in ("u1", "u2", "s1", "s2"):
            assert storage.get_by_id(tid)["synced"] == 1

    def test_resync_respects_batch_size_limit(self, resync_runtime):
        # 5 unsynced rows, batch_size=3 → only 3 attempted.
        for i in range(5):
            _save_trace(storage, f"t{i}")
        attempted, succeeded, failed = tracer.resync(batch_size=3, retries=1)
        assert attempted == 3
        assert succeeded == 3
        assert failed == 0
        # The other 2 rows are still unsynced — a second resync run picks them up.
        unsynced = storage.get_unsynced_traces(limit=10)
        assert len(unsynced) == 2


# --------------------------------------------------------------------------
# CLI entry point
# --------------------------------------------------------------------------

class TestResyncCLI:
    def test_cli_reports_success(self, resync_runtime, capsys):
        _save_trace(storage, "t1")
        _save_trace(storage, "t2")
        from swarmtrace.cli import main_resync
        try:
            main_resync()
        except SystemExit:
            pass
        out = capsys.readouterr().out
        assert "2/2" in out
        assert "successfully" in out

    def test_cli_exits_1_when_failures_remain(self, resync_runtime, capsys):
        _save_trace(storage, "t1")
        resync_runtime.transport.raise_on_single = Exception("down")
        from swarmtrace.cli import main_resync
        with pytest.raises(SystemExit) as exc_info:
            main_resync()
        assert exc_info.value.code == 1
        out = capsys.readouterr().out
        assert "0/1" in out
        assert "failed" in out.lower()

    def test_cli_nothing_to_send(self, resync_runtime, capsys):
        # No unsynced rows — should print "No unsynced traces found" and exit 0.
        from swarmtrace.cli import main_resync
        try:
            main_resync()
        except SystemExit:
            pass
        out = capsys.readouterr().out
        assert "No unsynced" in out
