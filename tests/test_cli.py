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


def test_view_preserves_full_32char_trace_id(cli, storage, capsys):
    """The full 32-char trace ID must appear in view() output.

    `swarmtrace-replay <id>` does an exact `get_by_id(trace_id)` lookup,
    so the ID displayed by view() must be the full 32-char UUID —
    truncating to 8 chars would make the replay workflow impossible
    (can't copy-paste, can't recover the full ID from a 8-char prefix).
    This test guards against any future "let's shorten the IDs in the
    tree view for aesthetics" change that breaks replay.
    """
    full_id = "0123456789abcdef0123456789abcdef"  # 32 hex chars, like uuid4().hex
    storage.save_trace(
        full_id, None, "rag_agent", "('q',)", "answer", 0.5, None,
        "2026-07-12T10:00:00+00:00",
        input_tokens=10, output_tokens=5, cost_usd=0.001,
        kind="agent", agent_id=full_id, agent_name="Test",
    )
    cli.view(limit=10)
    out = capsys.readouterr().out
    # The full 32-char ID must be in the output (table + tree view both).
    assert full_id in out, (
        f"Full 32-char trace ID not found in view() output — "
        f"was it truncated? Looked for: {full_id!r}"
    )


def test_view_tree_does_not_wrap_at_80_cols(cli, storage, capsys, monkeypatch):
    """Regression: tree view branches must not wrap onto a second line.

    Pre-fix, branch labels like `mistral_answer() (llm) [32-char-uuid]
    0.608s $0.000236 OK` exceeded 80 cols, and rich.Tree wrapped the
    trailing `OK` onto a new line, breaking the indentation:

        ├── mistral_answer() (llm) [41c2494b...] 0.608s $0.000236
        │   OK                                                          ← BROKEN

    Fix was to drop the redundant OK/ERROR suffix from the tree view
    (status is already shown in the table view above). This test sets
    COLUMNS=80 and verifies no tree branch line wraps.
    """
    # Force rich to render at 80 cols (it reads from COLUMNS env var)
    monkeypatch.setenv("COLUMNS", "80")
    # Seed a tree that would have wrapped pre-fix: long function name +
    # 32-char trace ID + non-zero cost (longer than $0).
    full_id = "abcdef1234567890abcdef1234567890"  # 32 chars
    storage.save_trace(
        full_id, None, "rag_agent_with_long_name", "('q',)", "a", 0.5, None,
        "2026-07-12T10:00:00+00:00",
        input_tokens=10, output_tokens=5, cost_usd=0.000236,
        kind="agent", agent_id=full_id, agent_name="Test",
    )
    storage.save_trace(
        "child1234567890abcdef1234567890", full_id,
        "mistral_answer_with_long_name", "('q', ['ctx'])", "a", 0.45, None,
        "2026-07-12T10:00:00+00:00",
        input_tokens=80, output_tokens=12, cost_usd=0.000652,
        kind="llm", agent_id=full_id, agent_name="Test",
    )
    cli.view(limit=10)
    out = capsys.readouterr().out

    # Find the tree section and verify no branch line wraps.
    # A wrapped line has the tree indent prefix (│   or spaces) but no
    # function name — i.e., it's a continuation of the previous line.
    tree_section = out.split("=== Agent Tree ===", 1)[-1]
    tree_lines = tree_section.split("\n")
    # Every line in the tree should contain a function name (rag_agent
    # or mistral_answer) or be the "Total" summary. Continuation lines
    # from wrapping would have neither.
    for i, line in enumerate(tree_lines):
        if "Total" in line or "===" in line or not line.strip():
            continue
        # Tree branch lines start with ├── or └── or are root lines.
        # They must contain a function name — wrapped continuations don't.
        if line.startswith(("├", "└", "rag_agent", "mistral")):
            assert "rag_agent" in line or "mistral_answer" in line or "retrieve" in line, (
                f"Tree line {i} looks like a wrapped continuation "
                f"(no function name): {line!r}"
            )
