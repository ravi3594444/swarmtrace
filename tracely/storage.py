import sqlite3
import os

DB_PATH = os.path.expanduser("~/.tracely.db")

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS traces (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            function TEXT,
            args TEXT,
            output TEXT,
            latency_sec REAL,
            error TEXT,
            timestamp TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cost_usd REAL
        )
    """)
    conn.commit()
    conn.close()

def save_trace(trace: dict):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        INSERT OR REPLACE INTO traces
        VALUES (:id, :parent_id, :function, :args, :output,
                :latency_sec, :error, :timestamp,
                :input_tokens, :output_tokens, :cost_usd)
    """, trace)
    conn.commit()
    conn.close()

def get_traces(limit=20):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT * FROM traces ORDER BY timestamp DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return rows

def get_by_id(trace_id):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT * FROM traces WHERE id = ?", (trace_id,)
    ).fetchone()
    conn.close()
    return row

def get_tree(parent_id=None):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT * FROM traces WHERE parent_id IS ? ORDER BY timestamp ASC", (parent_id,)
    ).fetchall()
    conn.close()
    return rows
