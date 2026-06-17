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

DB_PATH = os.environ.get("SWARMTRACE_DB_PATH", os.path.expanduser("~/.swarmtrace.db"))

MAX_ROWS: int = 10_000
PURGE_EVERY: int = 100      # Only COUNT(*) every N writes

TraceRow = Tuple  # (id, parent_id, function, args, output,
                  #  latency_sec, error, timestamp,
                  #  input_tokens, output_tokens, cost_usd,
                  #  kind, agent_id, agent_name)

# Columns added after the initial release. ALTER TABLE ADD COLUMN always
# appends to the end, so pre-existing ~/.swarmtrace.db files (created before
# kind/agent_id/agent_name existed) end up with the same column order as a
# freshly created DB.
_ADDED_COLUMNS: List[Tuple[str, str]] = [
    ("kind",       "TEXT NOT NULL DEFAULT 'agent'"),
    ("agent_id",   "TEXT"),
    ("agent_name", "TEXT"),
]

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
    """Add any columns from _ADDED_COLUMNS that are missing from an older DB."""
    have = {row[1] for row in conn.execute("PRAGMA table_info(traces)").fetchall()}
    for name, decl in _ADDED_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE traces ADD COLUMN {name} {decl}")

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
    kind: str = "function",
    agent_id: Optional[str] = None,
    agent_name: Optional[str] = None,
) -> None:
    """
    Persist one trace row.

    ``kind``/``agent_id``/``agent_name`` classify the span and attribute it
    to an agent — see :mod:`_tracer_ref` for the taxonomy. Callers that
    don't pass these (e.g. ad-hoc instrumentation outside ``@observe``) get
    ``kind="function"`` and are attributed to themselves, so they never show
    up as a phantom "agent" on the dashboard.
    """
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
                "kind, agent_id, agent_name) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (id_, parent_id, function, args, output,
                 latency_sec, error, timestamp,
                 input_tokens, output_tokens, cost_usd,
                 kind, agent_id, agent_name),
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