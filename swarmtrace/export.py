import csv
import json
import logging
import sys

from swarmtrace.storage import get_all_traces

_log = logging.getLogger("swarmtrace.export")


# ---------------------------------------------------------------------------
# CSV formula-injection sanitization
#
# Audit finding (medium): trace args/output/error/function are LLM-controlled
# or tool-controlled strings. If a malicious prompt or tool response contains
# a value starting with =, +, -, or @, Excel/LibreOffice/Google Sheets will
# interpret the cell as a formula on open. Classic attacks:
#
#   =cmd|'/c calc'!A1        → Excel DDE command execution
#   =HYPERLINK("http://evil","click")  → phishing link
#   @SUM(1+1)*cmd|'/c calc'!A1         → variant
#
# We neutralize by prefixing a single quote (') to any cell value whose
# string form starts with one of the dangerous characters. The quote is
# the spreadsheet-standard "this cell is text, not a formula" escape —
# Excel/Sheets display the value without the quote but no longer parse
# it as a formula. This is the OWASP-recommended mitigation.
#
# We apply it in _sanitize_csv_cell so every CSV export path goes through
# one chokepoint.
_CSV_INJECTION_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _sanitize_csv_cell(value):
    """Prefix a single quote to cell values that would be parsed as a
    spreadsheet formula. Non-string values pass through unchanged (csv
    writer will str() them; numbers/bools/None can't be formula-injected).

    Tab and CR are also neutralized because some spreadsheet apps treat
    a leading tab/CR as a formula trigger in certain locales.
    """
    if not isinstance(value, str):
        return value
    if value and value[0] in _CSV_INJECTION_PREFIXES:
        return "'" + value
    return value


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
    # Sanitize every cell against CSV formula injection before writing.
    # This is the chokepoint that stops LLM/tool-controlled strings from
    # becoming spreadsheet formulas when the export is opened.
    sanitized = [
        {k: _sanitize_csv_cell(v) for k, v in row.items()} for row in data
    ]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=sanitized[0].keys())
        writer.writeheader()
        writer.writerows(sanitized)
    _log.info("Exported %d traces to %s", len(sanitized), path)


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