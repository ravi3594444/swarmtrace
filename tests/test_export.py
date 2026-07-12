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
    import swarmtrace.storage as storage
    importlib.reload(storage)
    import swarmtrace.export as export
    importlib.reload(export)
    yield export
    if storage._conn is not None:
        storage._conn.close()
        storage._conn = None


def _save(storage_mod, **overrides):
    defaults = dict(
        id_="t1", parent_id=None, function="fn", args="()", output="out",
        latency_sec=0.1, error=None,
        timestamp="2026-01-01T00:00:00+00:00", input_tokens=10,
        output_tokens=5, cost_usd=0.001,
    )
    defaults.update(overrides)
    storage_mod.save_trace(**defaults)


def test_export_json_writes_all_traces(export_mod, tmp_path):
    import swarmtrace.storage as storage
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
    import swarmtrace.storage as storage
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
    import swarmtrace.storage as storage
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
    import swarmtrace.storage as storage
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
    import swarmtrace.storage as storage
    _save(storage, id_="a")

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.argv", ["swarmtrace-export"])
    export_mod.main()

    assert (tmp_path / "swarmtrace_export.json").exists()


def test_main_respects_format_csv_flag(export_mod, tmp_path, monkeypatch):
    import swarmtrace.storage as storage
    _save(storage, id_="a")

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.argv", ["swarmtrace-export", "--format", "csv"])
    export_mod.main()

    assert (tmp_path / "swarmtrace_export.csv").exists()
    assert not (tmp_path / "swarmtrace_export.json").exists()


def test_main_respects_output_path_flag(export_mod, tmp_path, monkeypatch):
    import swarmtrace.storage as storage
    _save(storage, id_="a")

    custom = tmp_path / "custom_name.json"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        "sys.argv", ["swarmtrace-export", "--output", str(custom)]
    )
    export_mod.main()

    assert custom.exists()


def test_main_combines_format_and_output_flags(export_mod, tmp_path, monkeypatch):
    import swarmtrace.storage as storage
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
