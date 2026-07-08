"""
Persistent SQLite storage for swarmtrace.

Design notes:
- WAL mode + NORMAL synchronous for write throughput without data loss risk.
- busy_timeout=5000 ms so concurrent writers wait instead of raising
  OperationalError: database is locked.
- Thread-safe via a module-level lock (one shared connection, reused).
- Auto-purge oldest rows when DB exceeds MAX_ROWS to keep it bounded.
- Periodic WAL checkpoint to prevent WAL file from growing unboundedly.
- All public functions swallow exceptions and return safe defaults so that
  a storage hiccup never crashes the agent being traced.
"""

import logging
import os
import sqlite3
import threading
from typing import List, Optional, Tuple

_log = logging.getLogger("swarmtrace")

DB_PATH = os.environ.get("SWARMTRACE_DB_PATH", os.path.expanduser("~/.swarmtrace.db"))

MAX_ROWS: int = 10_000
PURGE_EVERY: int = 100      # Only COUNT(*) every N writes

# Checkpoint WAL periodically so the WAL file doesn't grow unboundedly.
# Without this, a 24/7 process can accumulate hundreds of MB in the WAL file.
CHECKPOINT_EVERY: int = 500

# How long (ms) SQLite will wait for a lock before raising OperationalError.
# 5 s is generous enough for any realistic write burst.
BUSY_TIMEOUT_MS: int = 5_000

TraceRow = Tuple  # (id, parent_id, function, args, output,
                  #  latency_sec, error, timestamp,
                  #  input_tokens, output_tokens, cost_usd,
                  #  kind, agent_id, agent_name)

_ADDED_COLUMNS: List[Tuple[str, str]] = [
    ("kind",       "TEXT NOT NULL DEFAULT 'agent'"),
    ("agent_id",   "TEXT"),
    ("agent_name", "TEXT"),
    ("session_id", "TEXT"),
    # synced: 0 = pending remote ingest (or remote ingest failed), 1 = remote
    # ingest confirmed success. The tracer's background sender marks a row
    # synced=1 only after _send_remote returns without raising; the
    # `swarmtrace resync` CLI replays every row where synced=0 so a
    # transient endpoint outage doesn't permanently lose traces. Defaults
    # to 0 (NOT NULL DEFAULT 0) so existing INSERT statements that predate
    # this column still produce unsynced rows that resync can pick up.
    ("synced",     "INTEGER NOT NULL DEFAULT 0"),
]

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None
_write_count: int = 0

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        try:
            _conn.execute("SELECT 1")
        except Exception:
            _conn = None

    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        # busy_timeout: wait up to BUSY_TIMEOUT_MS before raising "database is locked"
        _conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS traces (
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
                agent_name    TEXT
            )
        """)
        _conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(timestamp DESC)"
        )
        _migrate_columns(_conn)
        _conn.commit()

    return _conn

def _migrate_columns(conn: sqlite3.Connection) -> None:
    have = {row[1] for row in conn.execute("PRAGMA table_info(traces)").fetchall()}
    for name, decl in _ADDED_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE traces ADD COLUMN {name} {decl}")

def _purge_old_rows(conn: sqlite3.Connection) -> None:
    row_count: int = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
    if row_count > MAX_ROWS:
        excess = row_count - MAX_ROWS
        conn.execute(
            "DELETE FROM traces WHERE id IN "
            "(SELECT id FROM traces ORDER BY timestamp ASC LIMIT ?)",
            (excess,),
        )

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def save_trace(
    id_: str,
    parent_id: Optional[str],
    function: str,
    args: str,
    output: Optional[str],
    latency_sec: float,
    error: Optional[str],
    timestamp: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float = 0.0,
    kind: str = "function",
    agent_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    session_id: Optional[str] = None,
) -> None:
    global _write_count
    agent_id = agent_id or id_
    agent_name = agent_name or function
    try:
        with _lock:
            conn = _get_conn()
            conn.execute(
                "INSERT OR REPLACE INTO traces "
                "(id, parent_id, function, args, output, latency_sec, error, "
                "timestamp, input_tokens, output_tokens, cost_usd, "
                "kind, agent_id, agent_name, session_id) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (id_, parent_id, function, args, output,
                 latency_sec, error, timestamp,
                 input_tokens, output_tokens, cost_usd,
                 kind, agent_id, agent_name, session_id),
            )
            _write_count += 1
            if _write_count % PURGE_EVERY == 0:
                _purge_old_rows(conn)
            # Periodic WAL checkpoint — keeps WAL file from growing to hundreds of MB
            if _write_count % CHECKPOINT_EVERY == 0:
                conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            conn.commit()
    except Exception as exc:
        _log.warning("storage warning: %s", exc)

def get_traces(limit: int = 20) -> List[TraceRow]:
    try:
        with _lock:
            conn = _get_conn()
            return conn.execute(
                "SELECT * FROM traces ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
    except Exception:
        return []

def get_all_traces(limit: Optional[int] = 500) -> List[TraceRow]:
    try:
        with _lock:
            conn = _get_conn()
            if limit is None:
                return conn.execute(
                    "SELECT * FROM traces ORDER BY timestamp DESC"
                ).fetchall()
            return conn.execute(
                "SELECT * FROM traces ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
    except Exception:
        return []

def get_by_id(trace_id: str) -> Optional[TraceRow]:
    try:
        with _lock:
            conn = _get_conn()
            return conn.execute(
                "SELECT * FROM traces WHERE id = ?", (trace_id,)
            ).fetchone()
    except Exception:
        return None


def mark_synced(trace_id: str, synced: int = 1) -> None:
    """Set the ``synced`` flag on a single trace row.

    Called by the tracer's background sender after a confirmed-successful
    remote POST (``synced=1``), and by the ``swarmtrace resync`` CLI when
    re-sending a previously-failed row succeeds. Swallows exceptions so a
    storage hiccup never crashes the worker thread or the CLI.
    """
    try:
        with _lock:
            conn = _get_conn()
            conn.execute(
                "UPDATE traces SET synced = ? WHERE id = ?",
                (1 if synced else 0, trace_id),
            )
            conn.commit()
    except Exception as exc:
        _log.warning("mark_synced warning: %s", exc)


def get_unsynced_traces(limit: int = 100) -> List[TraceRow]:
    """Return up to ``limit`` trace rows that haven't been confirmed synced.

    Used by the ``swarmtrace resync`` CLI to find rows whose remote POST
    failed (or never happened because the endpoint was unreachable). Rows
    are returned oldest-first so the resync replays them in the order they
    were captured.
    """
    try:
        with _lock:
            conn = _get_conn()
            return conn.execute(
                "SELECT * FROM traces WHERE synced = 0 "
                "ORDER BY timestamp ASC LIMIT ?",
                (limit,),
            ).fetchall()
    except Exception:
        return []

def purge_all() -> None:
    global _write_count
    with _lock:
        conn = _get_conn()
        conn.execute("DELETE FROM traces")
        conn.commit()
        _write_count = 0
