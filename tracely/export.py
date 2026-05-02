import json
import csv
import sys
from tracely.storage import get_all_traces


def _traces_to_dicts(rows):
    keys = ["id", "parent_id", "function", "args", "output", "latency_sec",
            "error", "timestamp", "input_tokens", "output_tokens", "cost_usd"]
    return [dict(zip(keys, row)) for row in rows]


def export_json(path="swarmtrace_export.json"):
    data = _traces_to_dicts(get_all_traces())
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Exported {len(data)} traces to {path}")


def export_csv(path="swarmtrace_export.csv"):
    data = _traces_to_dicts(get_all_traces())
    if not data:
        print("No traces to export.")
        return
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=data[0].keys())
        writer.writeheader()
        writer.writerows(data)
    print(f"Exported {len(data)} traces to {path}")


def main():
    fmt  = "json"
    path = None
    args = sys.argv[1:]

    if "--format" in args:
        idx = args.index("--format")
        if idx + 1 < len(args):
            fmt = args[idx + 1]

    if "--output" in args:
        idx = args.index("--output")
        if idx + 1 < len(args):
            path = args[idx + 1]

    if fmt == "csv":
        export_csv(path or "swarmtrace_export.csv")
    else:
        export_json(path or "swarmtrace_export.json")


if __name__ == "__main__":
    main()