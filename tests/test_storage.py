"""Tests for the SQLite trace storage layer."""

import importlib

import pytest


@pytest.fixture()
def storage(tmp_path, monkeypatch):
    """Reload the storage module against a temporary database file."""
    monkeypatch.setenv("SWARMTRACE_DB_PATH", str(tmp_path / "traces.db"))
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


def test_save_trace_round_trips_session_id(storage):
    storage.save_trace(
        "sid",
        None,
        "fn",
        "()",
        "out",
        0.1,
        None,
        "2026-01-03T00:00:00+00:00",
        1,
        2,
        0.003,
        session_id="thread-42",
    )
    row = storage.get_by_id("sid")
    assert row is not None
    # Row layout: id, parent_id, function, args, output, latency_sec, error,
    # timestamp, input_tokens, output_tokens, cost_usd, kind, agent_id,
    # agent_name, session_id, synced. session_id is index 14, synced is 15.
    assert row[14] == "thread-42"
    # New rows start unsynced (synced=0) until the background sender
    # confirms a successful remote POST.
    assert row[15] == 0


# ---------------------------------------------------------------------------
# _purge_old_rows — must NOT evict unsynced rows (silent data loss guard)
# ---------------------------------------------------------------------------

def test_purge_only_evicts_synced_rows(storage, monkeypatch):
    """When the DB exceeds MAX_ROWS, _purge_old_rows must only evict rows
    that have already been synced (synced=1). Evicting an unsynced row is
    silent data loss — that trace was captured but never reached the
    dashboard, and there's no other copy. The resync CLI can't recover
    what's been deleted."""
    # Lower MAX_ROWS so we can test without inserting 10k rows.
    monkeypatch.setattr(storage, "MAX_ROWS", 5)
    # Lower PURGE_EVERY so _purge_old_rows runs on the next save.
    monkeypatch.setattr(storage, "PURGE_EVERY", 1)

    # Insert 3 synced rows (oldest) + 3 unsynced rows (newest).
    # Total = 6 > MAX_ROWS=5, so purge should evict 1 synced row.
    for i in range(3):
        storage.save_trace(
            f"synced-{i}", None, "fn", "()", "out", 0.1, None,
            f"2026-01-0{i+1}T00:00:00+00:00", 0, 0, 0.0,
        )
        storage.mark_synced(f"synced-{i}", 1)
    for i in range(3):
        storage.save_trace(
            f"unsynced-{i}", None, "fn", "()", "out", 0.1, None,
            f"2026-02-0{i+1}T00:00:00+00:00", 0, 0, 0.0,
        )
        # leave synced=0 (default)

    # At this point: 6 rows, MAX_ROWS=5, excess=1.
    # Trigger purge with a 7th save (also unsynced) → excess=2, but the
    # purge runs AFTER the insert so it sees 7 rows. It will evict 2 synced
    # rows (the oldest two: synced-0 and synced-1).
    storage.save_trace(
        "trigger", None, "fn", "()", "out", 0.1, None,
        "2026-03-01T00:00:00+00:00", 0, 0, 0.0,
    )

    # The 2 oldest synced rows evicted.
    assert storage.get_by_id("synced-0") is None, "oldest synced row should be evicted"
    assert storage.get_by_id("synced-1") is None, "2nd oldest synced row should be evicted"
    # The newest synced row survives.
    assert storage.get_by_id("synced-2") is not None
    # ALL unsynced rows survive — even though the DB is over MAX_ROWS.
    for i in range(3):
        assert storage.get_by_id(f"unsynced-{i}") is not None, (
            f"unsynced-{i} must NOT be evicted (silent data loss)"
        )
    assert storage.get_by_id("trigger") is not None


def test_purge_leaves_db_over_max_when_only_unsynced_rows(storage, monkeypatch):
    """If the DB only has unsynced rows and exceeds MAX_ROWS, _purge_old_rows
    must NOT evict anything — the DB stays over MAX_ROWS. This is deliberate:
    better to grow the local DB (bounded by disk) than silently drop traces
    the user thinks are safe. The operator should notice via metrics/alerting."""
    monkeypatch.setattr(storage, "MAX_ROWS", 3)
    monkeypatch.setattr(storage, "PURGE_EVERY", 1)

    # Insert 5 unsynced rows — all over MAX_ROWS.
    for i in range(5):
        storage.save_trace(
            f"unsynced-{i}", None, "fn", "()", "out", 0.1, None,
            f"2026-01-0{i+1}T00:00:00+00:00", 0, 0, 0.0,
        )

    # Trigger purge.
    storage.save_trace(
        "trigger", None, "fn", "()", "out", 0.1, None,
        "2026-02-01T00:00:00+00:00", 0, 0, 0.0,
    )

    # All 5 unsynced rows + the trigger row survive (6 total, over MAX_ROWS=3).
    for i in range(5):
        assert storage.get_by_id(f"unsynced-{i}") is not None, (
            f"unsynced-{i} must survive — no synced rows to evict"
        )
    assert storage.get_by_id("trigger") is not None


def test_purge_evicts_oldest_synced_first(storage, monkeypatch):
    """When multiple synced rows exist, the oldest are evicted first
    (ORDER BY timestamp ASC). This matches the pre-fix behavior — only
    the WHERE synced=1 filter is new."""
    monkeypatch.setattr(storage, "MAX_ROWS", 3)
    monkeypatch.setattr(storage, "PURGE_EVERY", 1)

    # 4 synced rows with ascending timestamps.
    for i in range(4):
        storage.save_trace(
            f"row-{i}", None, "fn", "()", "out", 0.1, None,
            f"2026-01-0{i+1}T00:00:00+00:00", 0, 0, 0.0,
        )
        storage.mark_synced(f"row-{i}", 1)

    # Trigger purge (5th save, PURGE_EVERY=1). Now 5 rows total, excess=2.
    storage.save_trace(
        "trigger", None, "fn", "()", "out", 0.1, None,
        "2026-02-01T00:00:00+00:00", 0, 0, 0.0,
    )

    # row-0 and row-1 (oldest synced) evicted; row-2, row-3 survive.
    assert storage.get_by_id("row-0") is None
    assert storage.get_by_id("row-1") is None
    assert storage.get_by_id("row-2") is not None
    assert storage.get_by_id("row-3") is not None
