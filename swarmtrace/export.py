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


def export_json(path="swarmtrace_export.json") -> int:
    """Write every stored trace to *path* as JSON. Returns the row count."""
    data = _traces_to_dicts(get_all_traces())
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    _log.info("Exported %d traces to %s", len(data), path)
    return len(data)


def export_csv(path="swarmtrace_export.csv") -> int:
    """Write every stored trace to *path* as CSV. Returns the row count.

    Writes nothing (not even a header) when there are no traces, so an
    empty export can't be mistaken for a successful one downstream.
    """
    data = _traces_to_dicts(get_all_traces())
    if not data:
        _log.info("No traces to export.")
        return 0
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
    return len(sanitized)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

_FORMATS = {
    "json": (export_json, "swarmtrace_export.json"),
    "csv":  (export_csv,  "swarmtrace_export.csv"),
}

USAGE = """swarmtrace-export — dump the local trace DB to a file.

Usage:
  swarmtrace-export [--format json|csv] [--output PATH]

Options:
  --format FMT   Output format: json (default) or csv.
  --output PATH  Destination file. Defaults to ./swarmtrace_export.<fmt>.
  -h, --help     Show this message and exit.

Exit codes:
  0  export written (or nothing to export)
  1  the destination could not be written
  2  bad arguments
"""


def _parse_args(args: list[str]) -> tuple[str, str | None]:
    """Parse ``--format`` / ``--output``. Raises ValueError on bad input.

    Returns ``(fmt, path_or_None)``. Unknown formats and flags missing
    their value raise rather than silently falling back to the JSON
    default — a typo'd ``--format jsonl`` used to produce a .json file
    with no warning.
    """
    fmt = "json"
    path: str | None = None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--format", "--output"):
            if i + 1 >= len(args):
                raise ValueError(f"{arg} requires a value")
            value = args[i + 1]
            if arg == "--format":
                fmt = value.lower()
            else:
                path = value
            i += 2
            continue
        if arg.startswith("--format="):
            fmt = arg.split("=", 1)[1].lower()
        elif arg.startswith("--output="):
            path = arg.split("=", 1)[1]
        else:
            raise ValueError(f"unknown argument: {arg}")
        i += 1

    if fmt not in _FORMATS:
        raise ValueError(
            f"unknown --format {fmt!r} — expected one of {', '.join(sorted(_FORMATS))}"
        )
    return fmt, path


def main(argv: list[str] | None = None) -> int:
    """Entry point for the ``swarmtrace-export`` console script.

    Prints the result to stdout: the SDK never installs a logging handler,
    so the previous ``_log.info`` success message was invisible and the
    command looked like it had done nothing.
    """
    args = list(sys.argv[1:] if argv is None else argv)

    if any(a in ("-h", "--help") for a in args):
        print(USAGE, end="")
        return 0

    try:
        fmt, path = _parse_args(args)
    except ValueError as exc:
        print(f"swarmtrace-export: {exc}", file=sys.stderr)
        print(USAGE, end="", file=sys.stderr)
        return 2

    writer, default_path = _FORMATS[fmt]
    destination = path or default_path

    try:
        count = writer(destination)
    except OSError as exc:
        print(f"swarmtrace-export: could not write {destination}: {exc}", file=sys.stderr)
        return 1

    if count == 0 and fmt == "csv":
        print("No traces to export — nothing written.")
    else:
        print(f"Exported {count} trace(s) to {destination}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
