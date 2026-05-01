import sqlite3
import os
import json
import csv

DB_PATH = os.path.expanduser("~/.tracely.db")

def get_all_traces():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("SELECT * FROM traces ORDER BY timestamp DESC").fetchall()
    conn.close()
    return rows

def traces_to_dicts(rows):
    keys = ["id", "parent_id", "function", "args", "output", "latency_sec", "error", "timestamp", "input_tokens", "output_tokens", "cost_usd"]
    return [dict(zip(keys, row)) for row in rows]

def export_json(path="swarmtrace_export.json"):
    rows = get_all_traces()
    data = traces_to_dicts(rows)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Exported {len(data)} traces to {path}")

def export_csv(path="swarmtrace_export.csv"):
    rows = get_all_traces()
    data = traces_to_dicts(rows)
    if not data:
        print("No traces to export.")
        return
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=data[0].keys())
        writer.writeheader()
        writer.writerows(data)
    print(f"Exported {len(data)} traces to {path}")

if __name__ == "__main__":
    import sys
    fmt = sys.argv[1] if len(sys.argv) > 1 else "json"
    if fmt == "csv":
        export_csv()
    else:
        export_json()
