import sqlite3
import os
import sys

DB_PATH = os.path.expanduser("~/.tracely.db")

def get_traces():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("SELECT * FROM traces ORDER BY timestamp DESC LIMIT 20").fetchall()
    conn.close()
    return rows

def print_tree(traces, parent_id=None, indent=0):
    children = [t for t in traces if t[1] == parent_id]
    for t in children:
        id_, par, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = t
        status = "ERROR" if error else "OK"
        prefix = "    " * indent + ("└── " if indent > 0 else "")
        print(f"{prefix}{func}() [{id_}] {latency}s | {in_tok}in/{out_tok}out tokens | ${cost} | {status}")
        print_tree(traces, id_, indent + 1)

def view():
    try:
        traces = get_traces()
    except:
        traces = []

    if not traces:
        print("No traces found.")
        return

    total_cost = sum(t[10] for t in traces if t[10])
    total_tokens = sum((t[8] or 0) + (t[9] or 0) for t in traces)

    print("\n=== Tracely Trace View ===")
    print(f"{'ID':<10} {'FUNCTION':<20} {'LATENCY':<10} {'TOKENS':<15} {'COST':<12} {'STATUS'}")
    print("-" * 80)
    for t in traces:
        id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = t
        status = "ERROR" if error else "OK"
        tokens_str = f"{in_tok or 0}in/{out_tok or 0}out"
        print(f"{id_:<10} {func:<20} {str(latency)+'s':<10} {tokens_str:<15} ${cost or 0:<11} {status}")

    print("\n=== Tree View ===")
    print_tree(traces)

    print("\n=== Summary ===")
    print(f"Total traces : {len(traces)}")
    print(f"Total tokens : {total_tokens}")
    print(f"Total cost   : ${round(total_cost, 6)}")

if __name__ == "__main__":
    view()


def export(fmt="json"):
    from tracely.export import export_json, export_csv
    if fmt == "csv":
        export_csv()
    else:
        export_json()
