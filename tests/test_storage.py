"""Tests for the SQLite trace storage layer."""

import importlib
import logging
import os
import stat

import pytest


@pytest.fixture()
def storage(tmp_path, monkeypatch):
    """Reload the storage module against a temporary database file."""
    monkeypatch.setenv("SWARMTRACE_DB_PATH", str(tmp_path / "traces.db"))
    import swarmtrace.storage as s
    importlib.reload(s)
    yield s
    if s._conn is not None:
        s.close()


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
    # Disable time-based retention so test rows (2026-01) are not age-purged.
    monkeypatch.setattr(storage, "RETENTION_DAYS", 0)

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
    # Disable time-based retention so test rows (2026-01) are not age-purged.
    monkeypatch.setattr(storage, "RETENTION_DAYS", 0)

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
# data. Fix: _secure_db_path() securely opens a regular DB file as 0600,
# creates only package-owned directories as 0700, and rejects unsafe paths.
# ---------------------------------------------------------------------------

def test_db_file_created_with_0600_permissions(storage):
    """The DB file must be 0600 (owner-only) — not the umask default of 0644."""
    # Trigger _get_conn() (which calls _secure_db_path).
    conn = storage._get_conn()
    conn.execute("CREATE TABLE IF NOT EXISTS t (x INT)")
    conn.commit()

    mode = stat.S_IMODE(os.stat(storage.DB_PATH).st_mode)
    assert mode == 0o600, f"DB file mode is {oct(mode)}, expected 0o600"


def test_db_parent_dir_created_with_0700_when_we_create_it(storage, tmp_path):
    """When the DB path includes a not-yet-existing parent dir that WE
    create, that dir must be created with 0700 (owner-only)."""
    nested = tmp_path / "deep" / "subdir" / "traces.db"
    os.environ["SWARMTRACE_DB_PATH"] = str(nested)
    import importlib as _il
    _il.reload(storage)

    conn = storage._get_conn()
    conn.execute("CREATE TABLE IF NOT EXISTS t (x INT)")
    conn.commit()

    parent = os.path.dirname(os.path.abspath(storage.DB_PATH))
    dirmode = stat.S_IMODE(os.stat(parent).st_mode)
    assert dirmode == 0o700, f"Created parent dir mode is {oct(dirmode)}, expected 0o700"


def test_db_parent_dir_NOT_chmod_when_it_already_exists(storage, tmp_path):
    """Reviewer P1 fix: we must NOT chmod an existing parent directory.

    The first implementation unconditionally chmod'd the parent to 0700,
    which broke /tmp (1777→0700 when running as root), the user's home
    directory, and shared app directories. Now we only chmod dirs we
    created ourselves.
    """
    # tmp_path already exists (pytest creates it). Put the DB directly
    # inside it — tmp_path is the parent, and it already exists.
    db = tmp_path / "traces.db"
    os.environ["SWARMTRACE_DB_PATH"] = str(db)
    import importlib as _il
    _il.reload(storage)

    # Give tmp_path a non-0700 mode to verify we don't overwrite it.
    os.chmod(str(tmp_path), 0o755)

    conn = storage._get_conn()
    conn.execute("CREATE TABLE IF NOT EXISTS t (x INT)")
    conn.commit()

    # Parent dir mode must be UNCHANGED (0o755), not overwritten to 0o700.
    dirmode = stat.S_IMODE(os.stat(str(tmp_path)).st_mode)
    assert dirmode == 0o755, (
        f"Existing parent dir was chmod'd from 0o755 to {oct(dirmode)} — "
        f"this breaks shared/system directories like /tmp"
    )

    # DB file itself IS still tightened to 0600.
    filemode = stat.S_IMODE(os.stat(str(db)).st_mode)
    assert filemode == 0o600


def test_secure_db_path_is_idempotent(storage):
    """Calling _secure_db_path multiple times must be a no-op (no error,
    same permissions). _get_conn() calls it twice in succession."""
    conn = storage._get_conn()
    conn.execute("CREATE TABLE IF NOT EXISTS t (x INT)")
    conn.commit()

    storage._secure_db_path(storage.DB_PATH)
    storage._secure_db_path(storage.DB_PATH)
    storage._secure_db_path(storage.DB_PATH)

    mode = stat.S_IMODE(os.stat(storage.DB_PATH).st_mode)
    assert mode == 0o600


def test_secure_db_path_pre_creates_file_with_0600(tmp_path):
    """When the DB file doesn't exist yet, _secure_db_path pre-creates it
    with 0600 (via os.open) to avoid the umask race where sqlite3.connect
    would create it with 0644 before we could chmod it."""
    from swarmtrace.storage import _secure_db_path
    target = tmp_path / "precreated.db"
    _secure_db_path(str(target))

    # File was pre-created.
    assert target.exists()
    # And it's already 0600, not the umask default.
    mode = stat.S_IMODE(os.stat(str(target)).st_mode)
    assert mode == 0o600, f"Pre-created file mode is {oct(mode)}, expected 0o600"


def test_secure_db_path_does_not_raise_on_missing_file(tmp_path):
    """_secure_db_path must not raise when the DB file doesn't exist yet.
    It pre-creates it with 0600. The parent dir (tmp_path) already exists
    and must NOT be chmod'd (reviewer P1 fix)."""
    from swarmtrace.storage import _secure_db_path
    missing = tmp_path / "never.db"

    # Set a non-0700 mode on tmp_path to verify we don't overwrite it.
    # (pytest's tmp_path may default to 0o700 on some systems, so we
    # can't just assert "!= 0o700" — we need to set a known different
    # mode and verify it's preserved.)
    os.chmod(str(tmp_path), 0o755)

    # Must not raise.
    _secure_db_path(str(missing))

    # File was pre-created with 0600.
    assert missing.exists()
    mode = stat.S_IMODE(os.stat(str(missing)).st_mode)
    assert mode == 0o600

    # Parent dir (tmp_path, which already existed) must NOT have been
    # chmod'd — that was the P1 bug. Mode must still be 0o755.
    dirmode = stat.S_IMODE(os.stat(str(tmp_path)).st_mode)
    assert dirmode == 0o755, (
        f"existing parent dir was chmod'd from 0o755 to {oct(dirmode)} — "
        f"this is the P1 bug"
    )


def test_secure_db_path_fails_closed_when_fchmod_fails(tmp_path, monkeypatch):
    """A permission-hardening failure must disable storage, not continue
    writing sensitive traces to an insecure file."""
    import swarmtrace.storage as storage_mod

    target = tmp_path / "x.db"
    target.touch()

    def raise_fchmod(*args, **kwargs):
        raise OSError("permission denied (simulated)")

    monkeypatch.setattr(storage_mod.os, "fchmod", raise_fchmod)
    with pytest.raises(OSError, match="permission denied"):
        storage_mod._secure_db_path(str(target))


def test_secure_db_path_rejects_symlink(tmp_path):
    """The hardening helper must never chmod or open a symlink target."""
    import swarmtrace.storage as storage_mod

    target = tmp_path / "operator-config"
    target.write_text("not a database")
    os.chmod(target, 0o644)
    link = tmp_path / "traces.db"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("symbolic links are unavailable on this platform")

    with pytest.raises(OSError, match="non-regular"):
        storage_mod._secure_db_path(str(link))
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o644


@pytest.mark.skipif(os.name != "posix", reason="POSIX directory modes required")
def test_secure_db_path_rejects_other_writable_parent(tmp_path):
    """A predictable DB directly in a shared directory is symlink-raceable."""
    import swarmtrace.storage as storage_mod

    os.chmod(tmp_path, 0o777)
    with pytest.raises(PermissionError, match="group/other-writable"):
        storage_mod._secure_db_path(str(tmp_path / "traces.db"))


# ---------------------------------------------------------------------------
# close() — lock-safe connection teardown
#
# The connection is opened with check_same_thread=False so the background
# sender can write through it, which makes storage._lock the only thing
# serializing access. Closing the raw _conn from outside the lock while
# another thread is mid-query is a use-after-free: it takes the interpreter
# down with SIGSEGV, not a catchable Python exception. Reproduced 3/3 before
# close() existed.
# ---------------------------------------------------------------------------

_CLOSE_RACE_SCRIPT = """
import os, sys, threading, time
os.environ["SWARMTRACE_DB_PATH"] = sys.argv[1]
import swarmtrace.storage as s

s.save_trace(id_="x", function="f", timestamp="2026-01-01T00:00:00+00:00")

stop = False
def hammer():
    while not stop:
        s.mark_synced("x", 1)
        s.get_traces(limit=1)

threads = [threading.Thread(target=hammer, daemon=True) for _ in range(4)]
for t in threads:
    t.start()

for _ in range(200):
    time.sleep(0.005)
    s.close()

stop = True
for t in threads:
    t.join(timeout=2)
print("OK")
"""


def test_close_is_safe_while_other_threads_are_querying(tmp_path):
    """close() must not race the worker threads into a segfault.

    Run in a subprocess: if this regresses the failure mode is SIGSEGV, which
    would take the whole pytest process down rather than failing one test.
    """
    import subprocess
    import sys

    script = tmp_path / "close_race.py"
    script.write_text(_CLOSE_RACE_SCRIPT)
    proc = subprocess.run(
        [sys.executable, str(script), str(tmp_path / "race.db")],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, (
        f"close() raced into a crash (returncode {proc.returncode}); "
        f"stderr:\n{proc.stderr}"
    )
    assert "OK" in proc.stdout


def test_close_lets_the_next_call_reopen(storage):
    _save(storage, trace_id="reopen-me")
    storage.close()
    assert storage._conn is None
    # The next call transparently reconnects rather than raising.
    assert storage.get_by_id("reopen-me") is not None


def test_close_is_idempotent(storage):
    storage.close()
    storage.close()
    assert storage._conn is None


# ---------------------------------------------------------------------------
# Periodic WAL checkpoint
#
# The checkpoint used to be issued before conn.commit(), i.e. inside the write
# transaction the INSERT opens implicitly. SQLite cannot checkpoint inside a
# transaction, so every attempt raised SQLITE_LOCKED, the outer handler
# swallowed it as "storage warning: database table is locked", and the
# explicit checkpoint never once ran.
# ---------------------------------------------------------------------------

def test_periodic_checkpoint_runs_without_warnings(storage, caplog, monkeypatch):
    """Crossing the checkpoint interval must not log a storage warning."""
    # Checkpoint on the 5th write so the test stays fast.
    monkeypatch.setattr(storage, "CHECKPOINT_EVERY", 5)
    monkeypatch.setattr(storage, "_write_count", 0)

    with caplog.at_level("WARNING", logger="swarmtrace"):
        for i in range(12):
            _save(storage, trace_id=f"ckpt-{i}")

    # caplog.at_level() sets the level but does NOT filter caplog.records, so
    # narrow to this library's own warnings — an unrelated record from another
    # logger would otherwise fail this assertion for the wrong reason.
    warnings = [
        r.getMessage()
        for r in caplog.records
        if r.name.startswith("swarmtrace") and r.levelno >= logging.WARNING
    ]
    assert not warnings, f"checkpoint path logged storage warnings: {warnings}"

    # And every row still landed.
    assert len(storage.get_traces(limit=50)) == 12


def test_checkpoint_actually_executes(storage, monkeypatch):
    """The PRAGMA must reach SQLite, not be swallowed by the error handler.

    Uses sqlite3's trace callback, which reports every statement the
    connection actually executes — so this fails if the checkpoint raises
    SQLITE_LOCKED and gets swallowed, and it fails if the call is dropped.
    """
    monkeypatch.setattr(storage, "CHECKPOINT_EVERY", 3)
    monkeypatch.setattr(storage, "_write_count", 0)

    conn = storage._get_conn()
    statements: list[str] = []
    conn.set_trace_callback(statements.append)
    try:
        for i in range(6):
            _save(storage, trace_id=f"exec-{i}")
    finally:
        conn.set_trace_callback(None)

    checkpoints = [s for s in statements if "wal_checkpoint" in s]
    assert len(checkpoints) == 2, (
        f"expected 2 checkpoints across 6 writes, saw {checkpoints}"
    )
    # A checkpoint issued inside the write transaction raises and leaves the
    # connection mid-transaction; after the fix it runs on a clean one.
    assert conn.in_transaction is False
