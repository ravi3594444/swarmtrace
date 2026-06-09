"""
Persistent SQLite storage for swarmtrace.

Design notes:
- WAL mode + NORMAL synchronous for write throughput without data loss risk.
- Thread-safe via a module-level lock (one shared connection, reused).
- Auto-purge oldest rows when DB exceeds MAX_ROWS to keep it bounded.
- All public functions swallow exceptions and return safe defaults so that
  a storage hiccup never crashes the agent being traced.
"""

import os
import sqlite3
import sys
import threading
from typing import List, Optional, Tuple

DB_PATH = os.environ.get("TRACELY_DB_PATH", os.path.expanduser("~/.tracely.db"))

MAX_ROWS: int = 10_000
PURGE_EVERY: int = 100      # Only COUNT(*) every N writes

TraceRow = Tuple  # (id, parent_id, function, args, output,
                  #  latency_sec, error, timestamp,
                  #  input_tokens, output_tokens, cost_usd)

_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None
_write_count: int = 0

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_conn() -> sqlite3.Connection:
    global _conn
    # Health-check; reconnect if stale.
    if _conn is not None:
        try:
            _conn.execute("SELECT 1")
        except Exception:
            _conn = None

    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
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
                cost_usd      REAL    DEFAULT 0
            )
        """)
        _conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(timestamp DESC)"
        )
        _conn.commit()

    return _conn

def _purge_old_rows(conn: sqlite3.Connection) -> None:
    """Delete the oldest rows beyond MAX_ROWS."""
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
) -> None:
    global _write_count
    try:
        with _lock:
            conn = _get_conn()
            conn.execute(
                "INSERT OR REPLACE INTO traces VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (id_, parent_id, function, args, output,
                 latency_sec, error, timestamp,
                 input_tokens, output_tokens, cost_usd),
            )
            _write_count += 1
            if _write_count % PURGE_EVERY == 0:
                _purge_old_rows(conn)
            conn.commit()
    except Exception as exc:
        # Never crash the agent being traced — log to stderr and continue.
        print(f"[swarmtrace] storage warning: {exc}", file=sys.stderr)

def get_traces(limit: int = 20) -> List[TraceRow]:
    """Return the *limit* most recent traces, newest first."""
    try:
        with _lock:
            conn = _get_conn()
            return conn.execute(
                "SELECT * FROM traces ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
    except Exception:
        return []

def get_all_traces(limit: Optional[int] = 500) -> List[TraceRow]:
    """Return up to *limit* most recent traces.  Pass ``None`` for all (use with care)."""
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
    """Fetch a single trace by its short hex ID."""
    try:
        with _lock:
            conn = _get_conn()
            return conn.execute(
                "SELECT * FROM traces WHERE id = ?", (trace_id,)
            ).fetchone()
    except Exception:
        return None

def purge_all() -> None:
    """Wipe every trace row (useful in tests)."""
    with _lock:
        conn = _get_conn()
        conn.execute("DELETE FROM traces")
        conn.commit()