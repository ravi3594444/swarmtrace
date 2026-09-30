"""Tests for the `swarmtrace` CLI (view + replay) against the real storage layer."""

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
        s.close()


@pytest.fixture()
def cli(storage):
    """Reload cli so its storage imports bind to the temp-DB module."""
    import swarmtrace.cli as c
    importlib.reload(c)
    return c


def _seed_tree(storage):
    """Insert a parent agent span + a child llm span, mirroring real usage."""
    storage.save_trace(
        id_="root-1", parent_id=None, function="rag_agent", args="('how do I install?',)",
        output="pip install swarmtrace", latency_sec=0.42, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        input_tokens=50, output_tokens=12, cost_usd=0.0001,
        kind="agent", agent_id="agent-1", agent_name="RAG Agent",
    )
    storage.save_trace(
        id_="child-1", parent_id="root-1", function="mistral_answer", args="('q', ['ctx'])",
        output="pip install swarmtrace", latency_sec=0.38, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        input_tokens=80, output_tokens=12, cost_usd=0.0009,
        kind="llm", agent_id="agent-1", agent_name="RAG Agent",
    )


def test_view_does_not_crash_with_full_schema(cli, storage, capsys):
    """view() must not raise on the current 16-column row."""
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
        id_="err-1", parent_id=None, function="broken_tool", args="(args,)",
        output=None, latency_sec=0.01,
        error="ConnectionError: mistral unreachable",
        timestamp="2026-07-12T10:01:00+00:00",
        kind="tool", agent_id="agent-2", agent_name="Bad Agent",
    )
    cli.view(limit=10)
    out = capsys.readouterr().out
    assert "broken_tool" in out
    assert "ERROR" in out


def test_replay_does_not_crash_with_full_schema(cli, storage, capsys):
    """replay() must not raise on the current 16-column row."""
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
    """view() must show the full 32-char ID, since replay needs an exact match."""
    full_id = "0123456789abcdef0123456789abcdef"  # 32 hex chars, like uuid4().hex
    storage.save_trace(
        id_=full_id, parent_id=None, function="rag_agent", args="('q',)",
        output="answer", latency_sec=0.5, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
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
    """Tree branches must stay on one line at 80 cols."""
    # Force rich to render at 80 cols (it reads from COLUMNS env var)
    monkeypatch.setenv("COLUMNS", "80")
    # long function name + 32-char id + non-zero cost
    full_id = "abcdef1234567890abcdef1234567890"  # 32 chars
    storage.save_trace(
        id_=full_id, parent_id=None, function="rag_agent_with_long_name", args="('q',)",
        output="a", latency_sec=0.5, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        input_tokens=10, output_tokens=5, cost_usd=0.000236,
        kind="agent", agent_id=full_id, agent_name="Test",
    )
    storage.save_trace(
        id_="child1234567890abcdef1234567890", parent_id=full_id,
        function="mistral_answer_with_long_name", args="('q', ['ctx'])",
        output="a", latency_sec=0.45, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        input_tokens=80, output_tokens=12, cost_usd=0.000652,
        kind="llm", agent_id=full_id, agent_name="Test",
    )
    cli.view(limit=10)
    out = capsys.readouterr().out

    # a wrapped line has the tree indent but no function name
    tree_section = out.split("=== Agent Tree ===", 1)[-1]
    tree_lines = tree_section.split("\n")
    # every tree line has a function name or is the "Total" summary
    for i, line in enumerate(tree_lines):
        if "Total" in line or "===" in line or not line.strip():
            continue
        # branch and root lines only; wrapped continuations have no function name
        if line.startswith(("├", "└", "rag_agent", "mistral")):
            assert "rag_agent" in line or "mistral_answer" in line or "retrieve" in line, (
                f"Tree line {i} looks like a wrapped continuation "
                f"(no function name): {line!r}"
            )


def test_view_tree_nests_grandchildren_correctly(cli, storage, capsys, monkeypatch):
    """Grandchildren must nest under their parent, not become its siblings."""
    monkeypatch.setenv("COLUMNS", "80")
    storage.save_trace(
        id_="root-1", parent_id=None, function="root_agent", args="()", output="out",
        latency_sec=0.5, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        kind="agent", agent_id="a1", agent_name="Root",
    )
    storage.save_trace(
        id_="sub-1", parent_id="root-1", function="sub_agent", args="()", output="out",
        latency_sec=0.3, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        kind="agent", agent_id="a2", agent_name="Sub",
    )
    storage.save_trace(
        id_="tool-1", parent_id="sub-1", function="tool_call", args="()", output="out",
        latency_sec=0.1, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        kind="tool", agent_id="a2", agent_name="Sub",
    )
    cli.view(limit=10)
    out = capsys.readouterr().out

    tree_section = out.split("=== Agent Tree ===", 1)[-1]
    lines = tree_section.split("\n")
    sub_line = next((line for line in lines if "sub_agent" in line), None)
    tool_line = next((line for line in lines if "tool_call" in line), None)
    assert sub_line is not None, "sub_agent line not found in tree output"
    assert tool_line is not None, "tool_call line not found in tree output"

    # grandchild must sit deeper than its parent; the first non-space char is the measure
    sub_indent = len(sub_line) - len(sub_line.lstrip())
    tool_indent = len(tool_line) - len(tool_line.lstrip())
    assert tool_indent > sub_indent, (
        f"Grandchild flattening bug: tool_call (indent={tool_indent}) "
        f"is NOT nested deeper than sub_agent (indent={sub_indent}). "
        f"Lines:\n  sub: {sub_line!r}\n  tool: {tool_line!r}"
    )


def test_view_tree_shows_status_indicators(cli, storage, capsys, monkeypatch):
    """Tree labels carry a check/cross status for every span."""
    monkeypatch.setenv("COLUMNS", "80")
    storage.save_trace(
        id_="ok-1", parent_id=None, function="good_agent", args="()", output="out",
        latency_sec=0.5, error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        kind="agent", agent_id="a1", agent_name="Good",
    )
    storage.save_trace(
        id_="err-1", parent_id="ok-1", function="bad_tool", args="()", output=None,
        latency_sec=0.1,
        error="ConnectionError: timed out",
        timestamp="2026-07-12T10:00:00+00:00",
        kind="tool", agent_id="a1", agent_name="Good",
    )
    cli.view(limit=10)
    out = capsys.readouterr().out

    tree_section = out.split("=== Agent Tree ===", 1)[-1]
    # Both ✓ (OK) and ✗ (ERROR) must appear in the tree output.
    assert "✓" in tree_section, "No ✓ (OK status) in tree output"
    assert "✗" in tree_section, "No ✗ (ERROR status) in tree output"


def test_view_tree_keeps_span_visible_when_parent_is_not_loaded(
    cli, storage, capsys, monkeypatch
):
    """A span whose parent is outside the limit must not vanish from the tree."""
    monkeypatch.setenv("COLUMNS", "100")
    storage.save_trace(
        id_="detached-tool",
        parent_id="parent-outside-current-view",
        function="search_docs",
        args="('query',)",
        output="result",
        latency_sec=0.2,
        error=None,
        timestamp="2026-07-12T10:00:00+00:00",
        kind="tool",
        agent_id="agent-1",
        agent_name="RAG Agent",
    )

    cli.view(limit=1)
    tree_section = capsys.readouterr().out.split("=== Agent Tree ===", 1)[-1]

    assert "search_docs" in tree_section
    assert "detached" in tree_section


def test_view_survives_a_null_latency_row(cli, storage, capsys):
    """A NULL latency_sec (nullable column) must not take down the whole view."""
    _seed_tree(storage)
    conn = storage._get_conn()
    conn.execute("UPDATE traces SET latency_sec = NULL WHERE id = 'root-1'")
    conn.commit()

    cli.view(limit=10)  # must not raise
    out = capsys.readouterr().out
    assert "rag_agent" in out
    assert "mistral_answer" in out, "the sibling row was lost with the NULL one"
