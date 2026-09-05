"""Tests for swarmtrace/export.py.

Audit finding #8: export.py had zero test coverage. replay.py already
burned the project once (shipped with 196+ tests passing because nothing
exercised its actual behavior) -- export.py deserves the same scrutiny
before it does too.

Covers: JSON/CSV export content and shape, the "no traces" empty case,
and the CLI --format/--output arg parsing in main().
"""

from __future__ import annotations

import csv
import importlib
import json

import pytest


@pytest.fixture()
def export_mod(tmp_path, monkeypatch):
    """Reload storage + export against a temporary DB file, per test."""
    monkeypatch.setenv("SWARMTRACE_DB_PATH", str(tmp_path / "traces.db"))
    from swarmtrace import storage
    importlib.reload(storage)
    from swarmtrace import export
    importlib.reload(export)
    yield export
    if storage._conn is not None:
        storage.close()


def _save(storage_mod, **overrides):
    defaults = {
        "id_": "t1", "parent_id": None, "function": "fn", "args": "()", "output": "out",
        "latency_sec": 0.1, "error": None,
        "timestamp": "2026-01-01T00:00:00+00:00", "input_tokens": 10,
        "output_tokens": 5, "cost_usd": 0.001,
    }
    defaults.update(overrides)
    storage_mod.save_trace(**defaults)


def test_export_json_writes_all_traces(export_mod, tmp_path):
    from swarmtrace import storage
    _save(storage, id_="a")
    _save(storage, id_="b")

    out = tmp_path / "out.json"
    export_mod.export_json(str(out))

    assert out.exists()
    data = json.loads(out.read_text())
    assert isinstance(data, list)
    assert len(data) == 2
    assert {row["id"] for row in data} == {"a", "b"}


def test_export_json_includes_every_column_no_hardcoded_keys(export_mod, tmp_path):
    """_traces_to_dicts uses dict(row) with no hardcoded key list, so
    every column (including ones added by future migrations) should be
    present automatically."""
    from swarmtrace import storage
    _save(storage, id_="a")

    out = tmp_path / "out.json"
    export_mod.export_json(str(out))
    data = json.loads(out.read_text())

    row = data[0]
    for expected_key in (
        "id", "parent_id", "function", "args", "output", "latency_sec",
        "error", "timestamp", "input_tokens", "output_tokens", "cost_usd",
    ):
        assert expected_key in row, f"expected column {expected_key!r} in exported row"


def test_export_json_empty_db_writes_empty_list(export_mod, tmp_path):
    out = tmp_path / "empty.json"
    export_mod.export_json(str(out))
    assert out.exists()
    assert json.loads(out.read_text()) == []


def test_export_csv_writes_header_and_rows(export_mod, tmp_path):
    from swarmtrace import storage
    _save(storage, id_="a", function="fn_a")
    _save(storage, id_="b", function="fn_b")

    out = tmp_path / "out.csv"
    export_mod.export_csv(str(out))

    assert out.exists()
    with open(out, newline="") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 2
    assert {r["function"] for r in rows} == {"fn_a", "fn_b"}
    assert "id" in rows[0]


def test_export_csv_empty_db_does_not_create_file(export_mod, tmp_path):
    """export_csv bails out early (logs + returns) when there's nothing
    to export, rather than writing a header-only file."""
    out = tmp_path / "empty.csv"
    export_mod.export_csv(str(out))
    assert not out.exists()


def test_export_csv_fieldnames_match_first_row_keys(export_mod, tmp_path):
    from swarmtrace import storage
    _save(storage, id_="a")

    out = tmp_path / "out.csv"
    export_mod.export_csv(str(out))

    with open(out, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
    assert "id" in header
    assert "function" in header
    assert "timestamp" in header


def test_main_defaults_to_json_export(export_mod, tmp_path, monkeypatch):
    from swarmtrace import storage
    _save(storage, id_="a")

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.argv", ["swarmtrace-export"])
    export_mod.main()

    assert (tmp_path / "swarmtrace_export.json").exists()


def test_main_respects_format_csv_flag(export_mod, tmp_path, monkeypatch):
    from swarmtrace import storage
    _save(storage, id_="a")

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.argv", ["swarmtrace-export", "--format", "csv"])
    export_mod.main()

    assert (tmp_path / "swarmtrace_export.csv").exists()
    assert not (tmp_path / "swarmtrace_export.json").exists()


def test_main_respects_output_path_flag(export_mod, tmp_path, monkeypatch):
    from swarmtrace import storage
    _save(storage, id_="a")

    custom = tmp_path / "custom_name.json"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        "sys.argv", ["swarmtrace-export", "--output", str(custom)]
    )
    export_mod.main()

    assert custom.exists()


def test_main_combines_format_and_output_flags(export_mod, tmp_path, monkeypatch):
    from swarmtrace import storage
    _save(storage, id_="a")

    custom = tmp_path / "custom.csv"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        "sys.argv",
        ["swarmtrace-export", "--format", "csv", "--output", str(custom)],
    )
    export_mod.main()

    assert custom.exists()
    with open(custom, newline="") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# CSV formula-injection regression tests
#
# Audit finding (medium): trace args/output/error/function are LLM-controlled
# or tool-controlled strings. A malicious prompt or tool response can produce
# a value starting with =, +, -, or @ — Excel/LibreOffice/Google Sheets will
# parse the cell as a formula on open, enabling DDE command execution
# (=cmd|'/c calc'!A1) and phishing (=HYPERLINK("http://evil","click")).
#
# The fix prefixes a single quote to such values — the spreadsheet-standard
# "this cell is text" escape. Excel/Sheets display the value without the
# quote but no longer parse it as a formula. OWASP-recommended mitigation.
# ---------------------------------------------------------------------------

def test_sanitize_csv_cell_neutralizes_equals_prefix(export_mod):
    """=cmd|'/c calc'!A1 (DDE command injection) must be prefixed with '."""
    out = export_mod._sanitize_csv_cell("=cmd|'/c calc'!A1")
    assert out == "'=cmd|'/c calc'!A1"


def test_sanitize_csv_cell_neutralizes_plus_prefix(export_mod):
    out = export_mod._sanitize_csv_cell("+HYPERLINK(\"http://evil\")")
    assert out.startswith("'+")


def test_sanitize_csv_cell_neutralizes_minus_prefix(export_mod):
    """Some spreadsheets treat leading - as a formula trigger."""
    out = export_mod._sanitize_csv_cell("-1+1")
    assert out == "'-1+1"


def test_sanitize_csv_cell_neutralizes_at_prefix(export_mod):
    """@SUM(...) is a Lotus-1-2-3-style formula trigger in Excel."""
    out = export_mod._sanitize_csv_cell("@SUM(1+1)")
    assert out == "'@SUM(1+1)"


def test_sanitize_csv_cell_neutralizes_tab_and_cr_prefix(export_mod):
    """Leading tab/CR can be formula triggers in some locales."""
    assert export_mod._sanitize_csv_cell("\t=evil") == "'\t=evil"
    assert export_mod._sanitize_csv_cell("\rcalc") == "'\rcalc"


def test_sanitize_csv_cell_passes_through_safe_strings(export_mod):
    """Strings that don't start with a dangerous char must be unchanged."""
    assert export_mod._sanitize_csv_cell("normal output") == "normal output"
    assert export_mod._sanitize_csv_cell("hello =world") == "hello =world"
    assert export_mod._sanitize_csv_cell("[REDACTED]") == "[REDACTED]"


def test_sanitize_csv_cell_passes_through_non_strings(export_mod):
    """Numbers/None/bools can't be formula-injected — pass through unchanged."""
    assert export_mod._sanitize_csv_cell(42) == 42
    assert export_mod._sanitize_csv_cell(None) is None
    assert export_mod._sanitize_csv_cell(0.001) == 0.001
    assert export_mod._sanitize_csv_cell(True) is True


def test_sanitize_csv_cell_handles_empty_string(export_mod):
    assert export_mod._sanitize_csv_cell("") == ""


def test_export_csv_neutralizes_formula_injection_in_output(export_mod, tmp_path):
    """End-to-end: a trace whose output starts with '=' must be exported
    with the leading-quote escape, so opening the CSV in Excel cannot
    execute the formula."""
    from swarmtrace import storage
    _save(storage, id_="evil", output="=cmd|'/c calc'!A1")

    out = tmp_path / "evil.csv"
    export_mod.export_csv(str(out))

    with open(out, newline="") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 1
    # The cell value must start with the escape quote.
    assert rows[0]["output"] == "'=cmd|'/c calc'!A1", rows[0]["output"]


def test_export_csv_neutralizes_formula_injection_in_args(export_mod, tmp_path):
    """Same attack via the args column."""
    from swarmtrace import storage
    _save(storage, id_="evil2", args='+HYPERLINK("http://evil","click")')

    out = tmp_path / "evil2.csv"
    export_mod.export_csv(str(out))

    with open(out, newline="") as f:
        rows = list(csv.DictReader(f))
    # Cell must start with the escape quote, not the raw +.
    assert rows[0]["args"].startswith("'+"), rows[0]["args"]
    assert "+HYPERLINK" in rows[0]["args"]


def test_export_csv_preserves_safe_output(export_mod, tmp_path):
    """Regression guard: don't over-sanitize. A normal output string
    must pass through unchanged so the export stays useful for debugging."""
    from swarmtrace import storage
    _save(storage, id_="safe", output="the answer is 42")

    out = tmp_path / "safe.csv"
    export_mod.export_csv(str(out))

    with open(out, newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows[0]["output"] == "the answer is 42", rows[0]["output"]


def test_export_json_does_not_apply_csv_sanitization(export_mod, tmp_path):
    """JSON export must NOT be sanitized — JSON consumers don't interpret
    =/+/-/@ as formulas. Sanitizing JSON would corrupt the data."""
    from swarmtrace import storage
    _save(storage, id_="raw", output="=cmd|'/c calc'!A1")

    out = tmp_path / "raw.json"
    export_mod.export_json(str(out))

    data = json.loads(out.read_text())
    assert data[0]["output"] == "=cmd|'/c calc'!A1", data[0]["output"]


# ---------------------------------------------------------------------------
# CLI error paths
#
# main() documents 0 = written, 1 = destination unwritable, 2 = bad arguments,
# and the README repeats those codes. Only the success path was covered.
# ---------------------------------------------------------------------------

def test_main_rejects_an_unknown_format_with_exit_2(export_mod, tmp_path, monkeypatch, capsys):
    """A typo'd format must not silently fall back to JSON."""
    monkeypatch.chdir(tmp_path)
    assert export_mod.main(["--format", "yaml"]) == 2
    assert "unknown --format" in capsys.readouterr().err
    assert not (tmp_path / "swarmtrace_export.json").exists(), (
        "a rejected format still wrote an export file"
    )


def test_main_rejects_an_unknown_flag_with_exit_2(export_mod, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert export_mod.main(["--outpt", "x.json"]) == 2
    assert "unknown argument" in capsys.readouterr().err


def test_main_reports_a_missing_flag_value_with_exit_2(export_mod, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert export_mod.main(["--output"]) == 2
    assert "requires a value" in capsys.readouterr().err


def test_main_returns_1_when_the_destination_cannot_be_written(
    export_mod, tmp_path, monkeypatch, capsys
):
    """An unwritable path exits 1 with a clean message, not a traceback."""
    from swarmtrace import storage
    _save(storage, id_="a")

    monkeypatch.chdir(tmp_path)
    a_directory = tmp_path / "not-a-file"
    a_directory.mkdir()

    assert export_mod.main(["--output", str(a_directory)]) == 1
    err = capsys.readouterr().err
    assert "could not write" in err
    assert "Traceback" not in err


def test_main_help_prints_usage_and_writes_nothing(export_mod, tmp_path, monkeypatch, capsys):
    """--help used to fall through the flag parsing and export a file."""
    monkeypatch.chdir(tmp_path)
    assert export_mod.main(["--help"]) == 0
    assert "swarmtrace-export" in capsys.readouterr().out
    assert list(tmp_path.iterdir()) == [], "--help wrote files into the cwd"
