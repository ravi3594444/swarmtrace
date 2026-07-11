"""Regression tests for the `swarmtrace` CLI (view + replay).

Background: cli.py was unpacking 14 columns from each trace row, but the
traces table actually has 16 columns (added by the session_id and synced
migrations in storage.py:_ADDED_COLUMNS). `SELECT *` returned 16 values,
the tuple unpack crashed with `ValueError: too many values to unpack
(expected 14)`, and running `swarmtrace` after recording any trace failed
immediately. This test exercises view() and replay() against the real
storage layer so the same class of bug can't recur silently.
"""

import importlib

import pytest


@pytest.fixture()
def storage(tmp_path, monkeypatch):
    """Reload the storage module against a temporary database file."""
    monkeypatch.setenv("SWARMTRACE_DB_PATH", str(tmp_path / "traces.db"))
    import swarmtrace.storage as s
    importlib.reload(s)
    yield s
    if s._conn is not None:
        s._conn.close()
        s._conn = None


@pytest.fixture()
def cli(storage):
    """Reload cli against the isolated storage module.

    cli.py does `from swarmtrace.storage import get_traces, get_by_id` at
    module load time, so we have to reload it after reloading storage to
    make sure it's bound to the temp-DB version, not the global one.
    """
    import swarmtrace.cli as c
    importlib.reload(c)
    return c


def _seed_tree(storage):
    """Insert a parent agent span + a child llm span, mirroring real usage."""
    storage.save_trace(
        "root-1", None, "rag_agent", "('how do I install?',)",
        "pip install swarmtrace", 0.42, None,
        "2026-07-12T10:00:00+00:00",
        input_tokens=50, output_tokens=12, cost_usd=0.0001,
        kind="agent", agent_id="agent-1", agent_name="RAG Agent",
    )
    storage.save_trace(
        "child-1", "root-1", "mistral_answer", "('q', ['ctx'])",
        "pip install swarmtrace", 0.38, None,
        "2026-07-12T10:00:00+00:00",
        input_tokens=80, output_tokens=12, cost_usd=0.0009,
        kind="llm", agent_id="agent-1", agent_name="RAG Agent",
    )


def test_view_does_not_crash_with_full_schema(cli, storage, capsys):
    """Regression: view() must not raise on the current 16-column row.

    Pre-fix this raised `ValueError: too many values to unpack (expected 14)`
    because the unpack only named 14 fields while SELECT * returned 16.
    """
    _seed_tree(storage)
    # Must not raise.
    cli.view(limit=10)
    out = capsys.readouterr().out
    # Smoke-check that real data made it into the rendered output.
    assert "rag_agent" in out
    assert "mistral_answer" in out


def test_view_handles_empty_db(cli, storage, capsys):
    """view() on an empty DB should print a friendly message, not raise."""
    cli.view(limit=10)
    out = capsys.readouterr().out
    assert "No traces" in out


def test_view_handles_errors_and_kinds(cli, storage, capsys):
    """Rows with errors and non-agent kinds must render without raising."""
    storage.save_trace(
        "err-1", None, "broken_tool", "(args,)", None, 0.01,
        "ConnectionError: mistral unreachable",
        "2026-07-12T10:01:00+00:00",
        kind="tool", agent_id="agent-2", agent_name="Bad Agent",
    )
    cli.view(limit=10)
    out = capsys.readouterr().out
    assert "broken_tool" in out
    assert "ERROR" in out


def test_replay_does_not_crash_with_full_schema(cli, storage, capsys):
    """Regression: replay() must not raise on the current 16-column row."""
    _seed_tree(storage)
    cli.replay("root-1")
    out = capsys.readouterr().out
    assert "rag_agent" in out
    assert "RAG Agent" in out
    # Child shouldn't appear in replay output (replay is single-trace).
    assert "mistral_answer" not in out


def test_replay_missing_trace(cli, storage, capsys):
    """replay() on a non-existent id should print not-found, not raise."""
    cli.replay("does-not-exist")
    out = capsys.readouterr().out
    assert "not found" in out
