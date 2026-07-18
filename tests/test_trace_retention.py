"""Tests for the SQLite trace retention policy."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from swarmtrace.storage import (
    RETENTION_DAYS,
    get_traces,
    purge_now,
    save_trace,
)
import swarmtrace.storage as storage_module


@pytest.fixture
def fresh_storage(tmp_path, monkeypatch):
    """Use a temporary SQLite DB for each test."""
    db_path = str(tmp_path / "retention.sqlite")
    monkeypatch.setattr(storage_module, "DB_PATH", db_path)
    monkeypatch.setattr(storage_module, "_conn", None)
    monkeypatch.setattr(storage_module, "_write_count", 0)
    yield


def _save(id_, timestamp, synced=1):
    save_trace(
        id_=id_,
        function="fn",
        timestamp=timestamp.isoformat(),
        latency_sec=0.0,
        kind="function",
        agent_id="agent",
        agent_name="agent",
    )
    if synced:
        conn = storage_module._get_conn()
        conn.execute("UPDATE traces SET synced = 1 WHERE id = ?", (id_,))
        conn.commit()


def test_purge_by_age_removes_old_synced_rows(fresh_storage, monkeypatch):
    monkeypatch.setattr(storage_module, "RETENTION_DAYS", 7)
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=10)
    recent = now - timedelta(days=1)
    _save("old-span", old, synced=1)
    _save("recent-span", recent, synced=1)
    assert len(get_traces(limit=10)) == 2

    purge_now()
    remaining = [r["id"] for r in get_traces(limit=10)]
    assert "old-span" not in remaining
    assert "recent-span" in remaining


def test_purge_by_age_keeps_unsynced_rows(fresh_storage, monkeypatch):
    monkeypatch.setattr(storage_module, "RETENTION_DAYS", 7)
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=10)
    _save("old-unsynced", old, synced=0)
    assert len(get_traces(limit=10)) == 1

    purge_now()
    remaining = [r["id"] for r in get_traces(limit=10)]
    assert "old-unsynced" in remaining


def test_purge_by_age_disabled_when_zero(fresh_storage, monkeypatch):
    monkeypatch.setattr(storage_module, "RETENTION_DAYS", 0)
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=365)
    _save("very-old", old, synced=1)
    assert len(get_traces(limit=10)) == 1

    purge_now()
    remaining = [r["id"] for r in get_traces(limit=10)]
    assert "very-old" in remaining


def test_purge_on_write_triggered_every_n_writes(fresh_storage, monkeypatch):
    # Lower the threshold so the first write triggers a purge.
    monkeypatch.setattr(storage_module, "PURGE_EVERY", 1)
    monkeypatch.setattr(storage_module, "RETENTION_DAYS", 7)
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=10)
    _save("old-span", old, synced=1)
    _save("recent-span", now, synced=1)
    # The second write triggered purge_by_age, removing old-span.
    remaining = [r["id"] for r in get_traces(limit=10)]
    assert "old-span" not in remaining
    assert "recent-span" in remaining


def test_purge_by_count_keeps_most_recent_synced_rows(fresh_storage, monkeypatch):
    monkeypatch.setattr(storage_module, "MAX_ROWS", 3)
    monkeypatch.setattr(storage_module, "PURGE_EVERY", 1)
    monkeypatch.setattr(storage_module, "RETENTION_DAYS", 0)
    now = datetime.now(timezone.utc)
    for i in range(5):
        _save(f"span-{i}", now - timedelta(seconds=(5 - i)), synced=1)
    remaining = [r["id"] for r in get_traces(limit=10)]
    assert len(remaining) == 3
    assert "span-2" in remaining
    assert "span-3" in remaining
    assert "span-4" in remaining
    assert "span-0" not in remaining
    assert "span-1" not in remaining


def test_default_retention_days_is_positive():
    assert RETENTION_DAYS > 0
