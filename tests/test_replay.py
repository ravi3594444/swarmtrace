"""Tests for swarmtrace/replay.py.

Audit finding #8: replay.py had zero test coverage. Per the project's
own history, this module "already burned us once" -- 196+ tests passed
while a CLI crash, tree-view wrap bug, and grandchild-flattening bug all
shipped, because nothing exercised the actual replay/failure-listing
output. These tests cover show_failures() (this module) and the
replay() function it re-exports from swarmtrace.cli.
"""

from __future__ import annotations

import importlib
import logging

import pytest


@pytest.fixture()
def replay_mod(tmp_path, monkeypatch):
    """Reload storage + replay against a temporary DB file, per test."""
    monkeypatch.setenv("SWARMTRACE_DB_PATH", str(tmp_path / "traces.db"))
    import swarmtrace.storage as storage
    importlib.reload(storage)
    import swarmtrace.replay as replay
    importlib.reload(replay)
    yield replay
    if storage._conn is not None:
        storage._conn.close()
        storage._conn = None


def _save(function="fn", error=None, trace_id="t1", **overrides):
    import swarmtrace.storage as storage
    defaults = dict(
        id_=trace_id, parent_id=None, function=function, args="()", output="out",
        latency_sec=0.1, error=error,
        timestamp="2026-01-01T00:00:00+00:00", input_tokens=10,
        output_tokens=5, cost_usd=0.001,
    )
    defaults.update(overrides)
    storage.save_trace(**defaults)


# ── show_failures() ─────────────────────────────────────────────────────────

def test_show_failures_no_failures_logs_none_found(replay_mod, caplog):
    caplog.set_level(logging.INFO, logger="swarmtrace.replay")
    _save(function="ok_fn", error=None)
    replay_mod.show_failures()
    assert any("No failures found" in rec.message for rec in caplog.records)


def test_show_failures_lists_only_failed_traces(replay_mod, caplog):
    caplog.set_level(logging.INFO, logger="swarmtrace.replay")
    _save(trace_id="ok1", function="ok_fn", error=None)
    _save(trace_id="bad1", function="bad_fn", error="boom")
    replay_mod.show_failures()

    all_output = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "bad_fn" in all_output
    assert "bad1" in all_output
    # The successful trace's function name should not appear as a failure row.
    assert "Total failures: 1" in all_output


def test_show_failures_counts_multiple_failures(replay_mod, caplog):
    caplog.set_level(logging.INFO, logger="swarmtrace.replay")
    _save(trace_id="bad1", function="fn_a", error="err a")
    _save(trace_id="bad2", function="fn_b", error="err b")
    _save(trace_id="ok1", function="fn_c", error=None)
    replay_mod.show_failures()

    all_output = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "Total failures: 2" in all_output


def test_show_failures_empty_db_logs_none_found(replay_mod, caplog):
    caplog.set_level(logging.INFO, logger="swarmtrace.replay")
    replay_mod.show_failures()
    assert any("No failures found" in rec.message for rec in caplog.records)


def test_show_failures_truncates_long_error_text(replay_mod, caplog):
    caplog.set_level(logging.INFO, logger="swarmtrace.replay")
    long_error = "x" * 200
    _save(trace_id="bad1", function="fn_a", error=long_error)
    replay_mod.show_failures()
    # Should not crash on a long error string -- formatting truncates
    # to 38 chars via [:38] in the f-string args.
    all_output = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "x" * 38 in all_output


# ── replay() re-export from swarmtrace.cli ──────────────────────────────────

def test_replay_is_reexported_from_cli(replay_mod):
    import swarmtrace.cli as cli
    assert replay_mod.replay is cli.replay


def test_replay_unknown_trace_id_prints_not_found(replay_mod, capsys):
    replay_mod.replay("does-not-exist")
    captured = capsys.readouterr()
    assert "not found" in captured.out.lower()


def test_replay_known_trace_id_prints_details(replay_mod, capsys):
    _save(
        trace_id="known1", function="my_tool", error=None,
        args="('hello',)", output="world",
    )
    replay_mod.replay("known1")
    captured = capsys.readouterr()
    assert "my_tool" in captured.out
    assert "known1" in captured.out


def test_replay_shows_error_field_for_failed_trace(replay_mod, capsys):
    _save(trace_id="failed1", function="risky_tool", error="something broke")
    replay_mod.replay("failed1")
    captured = capsys.readouterr()
    assert "something broke" in captured.out
