"""Tests for the generic run()/span() API."""

import asyncio
import hashlib

import pytest

import swarmtrace
import swarmtrace.tracer as tracer


_SAVE_TRACE_FIELD_ORDER = (
    "id_", "parent_id", "function", "args", "output", "latency_sec",
    "error", "timestamp", "input_tokens", "output_tokens", "cost_usd",
    "kind", "agent_id", "agent_name", "session_id",
)


@pytest.fixture()
def records(monkeypatch, fake_runtime):
    """Capture spans through the Phase 1 runtime seam instead of patching
    tracer.save_trace. The tuple shape is preserved so every existing
    row[N] / row[-N] assertion keeps working unchanged.
    """
    saved = []

    def _capture(span):
        fake_runtime.repository.spans.append(span)
        saved.append(tuple(
            getattr(span, key) for key in (
                "span_id", "parent_span_id", "name", "args", "output",
                "latency_sec", "error", "start_time", "input_tokens",
                "output_tokens", "cost_usd", "kind", "agent_id", "agent_name",
                "session_id",
            )
        ))
        # Convert datetime to the same ISO timestamp string the old tests used.
        saved[-1] = saved[-1][:7] + (saved[-1][7].isoformat(),) + saved[-1][8:]

    monkeypatch.setattr(fake_runtime.repository, "save", _capture)
    return saved


def _row_id(row):
    return row[0]


def _row_parent_id(row):
    return row[1]


def _row_function(row):
    return row[2]


def _row_kind(row):
    return row[11]


def _row_agent_id(row):
    return row[12]


def _row_agent_name(row):
    return row[13]


def _row_session_id(row):
    return row[14]


def _row_error(row):
    return row[6]


def _find_row(records, function):
    for row in records:
        if _row_function(row) == function:
            return row
    raise AssertionError(f"no row with function {function!r} in {records}")


def test_sync_run_creates_root_agent_span(records):
    with swarmtrace.run("research-agent"):
        pass

    assert len(records) == 1
    row = records[0]
    assert _row_function(row) == "research-agent"
    assert _row_kind(row) == "agent"
    assert _row_parent_id(row) is None
    assert _row_agent_id(row) == hashlib.sha256("research-agent".encode()).hexdigest()
    assert _row_agent_name(row) == "research-agent"
    assert _row_error(row) is None


def test_repeated_run_uses_stable_agent_id(records):
    with swarmtrace.run("research-agent"):
        pass
    with swarmtrace.run("research-agent"):
        pass

    assert len(records) == 2
    assert _row_agent_id(records[0]) == _row_agent_id(records[1])


def test_async_run_creates_root_agent_span(records):
    async def _main():
        async with swarmtrace.run("async-agent"):
            pass

    asyncio.run(_main())

    assert len(records) == 1
    row = records[0]
    assert _row_function(row) == "async-agent"
    assert _row_kind(row) == "agent"
    assert _row_parent_id(row) is None


def test_nested_span_under_run_sets_parent(records):
    with swarmtrace.run("research-agent"):
        with swarmtrace.span("fetch-data", kind="tool"):
            pass

    assert len(records) == 2
    run_row = _find_row(records, "research-agent")
    span_row = _find_row(records, "fetch-data")
    assert _row_parent_id(run_row) is None
    assert _row_parent_id(span_row) == _row_id(run_row)
    assert _row_kind(span_row) == "tool"
    assert _row_agent_id(span_row) == _row_agent_id(run_row)
    assert _row_agent_name(span_row) == _row_agent_name(run_row)


def test_run_and_observe_share_context(records):
    @swarmtrace.observe
    def helper(x):
        return x * 2

    with swarmtrace.run("research-agent"):
        helper(21)

    assert len(records) == 2
    run_row = _find_row(records, "research-agent")
    helper_row = _find_row(records, "helper")
    assert _row_parent_id(helper_row) == _row_id(run_row)
    assert _row_agent_id(helper_row) == _row_agent_id(run_row)
    assert _row_kind(helper_row) == "function"


def test_run_inherits_session(records):
    with swarmtrace.session("conversation-42"):
        with swarmtrace.run("research-agent"):
            with swarmtrace.span("fetch-data", kind="tool"):
                pass

    assert len(records) == 2
    run_row = _find_row(records, "research-agent")
    span_row = _find_row(records, "fetch-data")
    assert _row_session_id(run_row) == "conversation-42"
    assert _row_session_id(span_row) == "conversation-42"


def test_run_exception_propagates_and_records_error(records):
    class CustomError(Exception):
        pass

    with pytest.raises(CustomError):
        with swarmtrace.run("research-agent"):
            raise CustomError("boom")

    assert len(records) == 1
    row = records[0]
    assert _row_error(row) == "boom"
    assert _row_kind(row) == "agent"


def test_async_run_exception_propagates_and_records_error(records):
    class CustomError(Exception):
        pass

    async def _main():
        async with swarmtrace.run("research-agent"):
            raise CustomError("async boom")

    with pytest.raises(CustomError):
        asyncio.run(_main())

    assert len(records) == 1
    assert _row_error(records[0]) == "async boom"


def test_span_without_run_is_orphan(records):
    with swarmtrace.span("orphan-tool", kind="tool"):
        pass

    assert len(records) == 1
    row = records[0]
    assert _row_function(row) == "orphan-tool"
    assert _row_kind(row) == "tool"
    assert _row_parent_id(row) is None
    assert _row_agent_id(row) is None


def test_nested_async_span_under_run(records):
    async def _main():
        async with swarmtrace.run("research-agent"):
            async with swarmtrace.span("fetch-data", kind="tool"):
                pass

    asyncio.run(_main())

    assert len(records) == 2
    run_row = _find_row(records, "research-agent")
    span_row = _find_row(records, "fetch-data")
    assert _row_parent_id(span_row) == _row_id(run_row)
