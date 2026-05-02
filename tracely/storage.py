import sqlite3
import os

DB_PATH = os.path.expanduser("~/.tracely.db")

# ---------- schema bootstrap ----------

def _init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS traces (
            id          TEXT PRIMARY KEY,
            parent_id   TEXT,
            function    TEXT,
            args        TEXT,
            output      TEXT,
            latency_sec REAL,
            error       TEXT,
            timestamp   TEXT,
            input_tokens  INTEGER,
            output_tokens INTEGER,
            cost_usd    REAL
        )
    """)
    conn.commit()
    conn.close()

_init_db()

# ---------- write ----------

def save_trace(id_, parent_id, function, args, output,
               latency_sec, error, timestamp,
               input_tokens, output_tokens, cost_usd):
    """Insert one trace row into the DB."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """INSERT OR REPLACE INTO traces VALUES
           (?,?,?,?,?,?,?,?,?,?,?)""",
        (id_, parent_id, function, args, output,
         latency_sec, error, timestamp,
         input_tokens, output_tokens, cost_usd)
    )
    conn.commit()
    conn.close()

# ---------- read ----------

def get_traces(limit=20):
    """Return the most-recent *limit* traces (used by CLI)."""
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT * FROM traces ORDER BY timestamp DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
        return rows
    except Exception:
        return []

def get_all_traces():
    """Return every trace (used by export)."""
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT * FROM traces ORDER BY timestamp DESC"
        ).fetchall()
        conn.close()
        return rows
    except Exception:
        return []