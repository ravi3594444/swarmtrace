"""Tests for the SQLite trace storage layer."""

import importlib

import pytest


@pytest.fixture()
def storage(tmp_path, monkeypatch):
    """Reload the storage module against a temporary database file."""
    monkeypatch.setenv("TRACELY_DB_PATH", str(tmp_path / "traces.db"))
    import swarmtrace.storage as s
    importlib.reload(s)
    yield s
    if s._conn is not None:
        s._conn.close()
        s._conn = None


def _save(storage, trace_id="abc", error=None):
    storage.save_trace(
        trace_id, None, "fn", "()", "out", 0.1, error,
        "2026-01-01T00:00:00+00:00", 10, 5, 0.001,
    )


def test_save_and_get_by_id(storage):
    _save(storage)
    row = storage.get_by_id("abc")
    assert row is not None
    assert row[2] == "fn"
    assert row[8] == 10


def test_get_traces_newest_first(storage):
    storage.save_trace("a", None, "f1", "()", "", 0.1, None, "2026-01-01T00:00:00+00:00")
    storage.save_trace("b", None, "f2", "()", "", 0.1, None, "2026-01-02T00:00:00+00:00")
    rows = storage.get_traces(limit=10)
    assert [r[0] for r in rows] == ["b", "a"]


def test_purge_all(storage):
    _save(storage)
    storage.purge_all()
    assert storage.get_all_traces() == []


def test_save_never_raises(storage, monkeypatch):
    # Simulate a broken connection — save_trace must swallow the error.
    monkeypatch.setattr(storage, "_get_conn", lambda: (_ for _ in ()).throw(OSError("disk")))
    _save(storage)  # must not raise
