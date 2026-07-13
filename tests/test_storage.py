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
        id_=trace_id, parent_id=None, function="fn", args="()", output="out",
        latency_sec=0.1, error=error,
        timestamp="2026-01-01T00:00:00+00:00", input_tokens=10,
        output_tokens=5, cost_usd=0.001,
    )


def test_save_and_get_by_id(storage):
    _save(storage)
    row = storage.get_by_id("abc")
    assert row is not None
    assert row["function"] == "fn"
    assert row["input_tokens"] == 10


def test_get_traces_newest_first(storage):
    storage.save_trace(id_="a", parent_id=None, function="f1", args="()", output="",
                        latency_sec=0.1, error=None, timestamp="2026-01-01T00:00:00+00:00")
    storage.save_trace(id_="b", parent_id=None, function="f2", args="()", output="",
                        latency_sec=0.1, error=None, timestamp="2026-01-02T00:00:00+00:00")
    rows = storage.get_traces(limit=10)
    assert [r["id"] for r in rows] == ["b", "a"]


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
        id_="sid",
        parent_id=None,
        function="fn",
        args="()",
        output="out",
        latency_sec=0.1,
        error=None,
        timestamp="2026-01-03T00:00:00+00:00",
        input_tokens=1,
        output_tokens=2,
        cost_usd=0.003,
        session_id="thread-42",
    )
    row = storage.get_by_id("sid")
    assert row is not None
    assert row["session_id"] == "thread-42"
    # New rows start unsynced (synced=0) until the background sender
    # confirms a successful remote POST.
    assert row["synced"] == 0


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
            id_=f"synced-{i}", parent_id=None, function="fn", args="()", output="out",
            latency_sec=0.1, error=None,
            timestamp=f"2026-01-0{i+1}T00:00:00+00:00",
            input_tokens=0, output_tokens=0, cost_usd=0.0,
        )
        storage.mark_synced(f"synced-{i}", 1)
    for i in range(3):
        storage.save_trace(
            id_=f"unsynced-{i}", parent_id=None, function="fn", args="()", output="out",
            latency_sec=0.1, error=None,
            timestamp=f"2026-02-0{i+1}T00:00:00+00:00",
            input_tokens=0, output_tokens=0, cost_usd=0.0,
        )
        # leave synced=0 (default)

    # At this point: 6 rows, MAX_ROWS=5, excess=1.
    # Trigger purge with a 7th save (also unsynced) → excess=2, but the
    # purge runs AFTER the insert so it sees 7 rows. It will evict 2 synced
    # rows (the oldest two: synced-0 and synced-1).
    storage.save_trace(
        id_="trigger", parent_id=None, function="fn", args="()", output="out",
        latency_sec=0.1, error=None,
        timestamp="2026-03-01T00:00:00+00:00",
        input_tokens=0, output_tokens=0, cost_usd=0.0,
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
            id_=f"unsynced-{i}", parent_id=None, function="fn", args="()", output="out",
            latency_sec=0.1, error=None,
            timestamp=f"2026-01-0{i+1}T00:00:00+00:00",
            input_tokens=0, output_tokens=0, cost_usd=0.0,
        )

    # Trigger purge.
    storage.save_trace(
        id_="trigger", parent_id=None, function="fn", args="()", output="out",
        latency_sec=0.1, error=None,
        timestamp="2026-02-01T00:00:00+00:00",
        input_tokens=0, output_tokens=0, cost_usd=0.0,
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
            id_=f"row-{i}", parent_id=None, function="fn", args="()", output="out",
            latency_sec=0.1, error=None,
            timestamp=f"2026-01-0{i+1}T00:00:00+00:00",
            input_tokens=0, output_tokens=0, cost_usd=0.0,
        )
        storage.mark_synced(f"row-{i}", 1)

    # Trigger purge (5th save, PURGE_EVERY=1). Now 5 rows total, excess=2.
    storage.save_trace(
        id_="trigger", parent_id=None, function="fn", args="()", output="out",
        latency_sec=0.1, error=None,
        timestamp="2026-02-01T00:00:00+00:00",
        input_tokens=0, output_tokens=0, cost_usd=0.0,
    )

    # row-0 and row-1 (oldest synced) evicted; row-2, row-3 survive.
    assert storage.get_by_id("row-0") is None
    assert storage.get_by_id("row-1") is None
    assert storage.get_by_id("row-2") is not None
    assert storage.get_by_id("row-3") is not None


# ---------------------------------------------------------------------------
# DB file permission hardening (audit finding: world-readable DB)
#
# Bug: ~/.swarmtrace.db was created with the process umask (typically 0644
# on most systems), so on a multi-user machine any local user could read
# captured prompts, outputs, args, error messages, and FOV browser-event
# data. Fix: _secure_db_path() chmods the DB file to 0600 and its parent
# dir to 0700 on every _get_conn(). These tests lock that in.
# ---------------------------------------------------------------------------

import os
import stat


def test_db_file_created_with_0600_permissions(storage):
    """The DB file must be 0600 (owner-only) — not the umask default of 0644."""
    # Trigger _get_conn() (which calls _secure_db_path).
    conn = storage._get_conn()
    conn.execute("CREATE TABLE IF NOT EXISTS t (x INT)")
    conn.commit()

    mode = stat.S_IMODE(os.stat(storage.DB_PATH).st_mode)
    assert mode == 0o600, f"DB file mode is {oct(mode)}, expected 0o600"


def test_db_parent_dir_created_with_0700_permissions(storage, tmp_path):
    """When the DB path includes a not-yet-existing parent dir, that dir
    must be created with 0700 (owner-only), not the umask default."""
    # Reload storage with a nested path that doesn't exist yet.
    nested = tmp_path / "deep" / "subdir" / "traces.db"
    os.environ["SWARMTRACE_DB_PATH"] = str(nested)
    import importlib as _il
    _il.reload(storage)

    conn = storage._get_conn()
    conn.execute("CREATE TABLE IF NOT EXISTS t (x INT)")
    conn.commit()

    parent = os.path.dirname(os.path.abspath(storage.DB_PATH))
    dirmode = stat.S_IMODE(os.stat(parent).st_mode)
    assert dirmode == 0o700, f"Parent dir mode is {oct(dirmode)}, expected 0o700"


def test_secure_db_path_is_idempotent(storage):
    """Calling _secure_db_path multiple times must be a no-op (no error,
    same permissions). _get_conn() calls it twice in succession; if it
    weren't idempotent, every connection would warn-log."""
    conn = storage._get_conn()
    conn.execute("CREATE TABLE IF NOT EXISTS t (x INT)")
    conn.commit()

    # Call it directly several times — no exception, perms unchanged.
    storage._secure_db_path(storage.DB_PATH)
    storage._secure_db_path(storage.DB_PATH)
    storage._secure_db_path(storage.DB_PATH)

    mode = stat.S_IMODE(os.stat(storage.DB_PATH).st_mode)
    assert mode == 0o600


def test_secure_db_path_does_not_raise_on_missing_file(tmp_path):
    """_secure_db_path must not raise when the DB file doesn't exist yet
    (the pre-connect call). It should still tighten the parent dir."""
    from swarmtrace.storage import _secure_db_path
    missing = tmp_path / "never.db"
    # Must not raise.
    _secure_db_path(str(missing))
    # Parent dir (tmp_path) was tightened to 0700.
    dirmode = stat.S_IMODE(os.stat(str(tmp_path)).st_mode)
    assert dirmode == 0o700


def test_secure_db_path_does_not_raise_on_unwritable_dir(tmp_path, monkeypatch):
    """Permission-tightening failures must never crash the agent being traced.
    If os.chmod raises (e.g. running as a non-owner), _secure_db_path logs
    and continues."""
    from swarmtrace.storage import _secure_db_path
    target = tmp_path / "x.db"
    target.touch()

    def raise_os_chmod(*args, **kwargs):
        raise OSError("permission denied (simulated)")

    monkeypatch.setattr("os.chmod", raise_os_chmod)
    # Must not raise.
    _secure_db_path(str(target))
