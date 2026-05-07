import sqlite3
import os
import threading


DB_PATH = os.path.expanduser("~/.tracely.db")

# Persistent connection with thread lock — avoids per-call connection overhead
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

MAX_ROWS = 10_000  # auto-purge oldest rows beyond this limit


def _get_conn() -> sqlite3.Connection:
    global _conn
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
                input_tokens  INTEGER,
                output_tokens INTEGER,
                cost_usd      REAL
            )
        """)
        # Index for fast timestamp-ordered queries
        _conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp DESC)"
        )
        _conn.commit()
    return _conn


def _purge_old_rows(conn: sqlite3.Connection):
    """Keep DB from growing unboundedly — delete oldest rows beyond MAX_ROWS."""
    row_count = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
    if row_count > MAX_ROWS:
        excess = row_count - MAX_ROWS
        conn.execute("""
            DELETE FROM traces WHERE id IN (
                SELECT id FROM traces ORDER BY timestamp ASC LIMIT ?
            )
        """, (excess,))


def save_trace(id_, parent_id, function, args, output,
               latency_sec, error, timestamp,
               input_tokens, output_tokens, cost_usd):
    with _lock:
        conn = _get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO traces VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (id_, parent_id, function, args, output,
             latency_sec, error, timestamp,
             input_tokens, output_tokens, cost_usd)
        )
        _purge_old_rows(conn)
        conn.commit()


def get_traces(limit=20):
    try:
        with _lock:
            conn = _get_conn()
            rows = conn.execute(
                "SELECT * FROM traces ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
        return rows
    except Exception:
        return []


def get_all_traces(limit=500):
    """Returns up to `limit` most recent traces. Use limit=None for all (caution: memory)."""
    try:
        with _lock:
            conn = _get_conn()
            if limit is None:
                rows = conn.execute(
                    "SELECT * FROM traces ORDER BY timestamp DESC"
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM traces ORDER BY timestamp DESC LIMIT ?", (limit,)
                ).fetchall()
        return rows
    except Exception:
        return []


def purge_all():
    """Manually wipe all traces."""
    with _lock:
        conn = _get_conn()
        conn.execute("DELETE FROM traces")
        conn.commit()


def get_by_id(trace_id: str):
    """Fetch a single trace by ID."""
    try:
        with _lock:
            conn = _get_conn()
            row = conn.execute(
                "SELECT * FROM traces WHERE id = ?", (trace_id,)
            ).fetchone()
        return row
    except Exception:
        return None
