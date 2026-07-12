import json
import csv
import logging
import sys
from swarmtrace.storage import get_all_traces

_log = logging.getLogger("swarmtrace.export")


def _traces_to_dicts(rows):
    # storage.get_all_traces() now returns dicts (one key per column) rather
    # than positional tuples, so every column -- including session_id and
    # synced, and any future migration column -- is included automatically.
    # No hardcoded key list to fall out of sync with the schema.
    return [dict(row) for row in rows]


def export_json(path="swarmtrace_export.json"):
    data = _traces_to_dicts(get_all_traces())
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    _log.info("Exported %d traces to %s", len(data), path)


def export_csv(path="swarmtrace_export.csv"):
    data = _traces_to_dicts(get_all_traces())
    if not data:
        _log.info("No traces to export.")
        return
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=data[0].keys())
        writer.writeheader()
        writer.writerows(data)
    _log.info("Exported %d traces to %s", len(data), path)


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