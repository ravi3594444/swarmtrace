"""Tests for the @observe decorator (sync, async, linkage, errors)."""

import asyncio

import pytest

import swarmtrace.tracer as tracer


@pytest.fixture()
def records(monkeypatch):
    """Capture save_trace calls instead of writing to the real SQLite DB."""
    saved = []
    monkeypatch.setattr(tracer, "save_trace", lambda *a, **k: saved.append(a))
    # Ensure remote ingest stays disabled regardless of the host environment.
    monkeypatch.delenv("SWARMTRACE_API_KEY", raising=False)
    monkeypatch.delenv("SWARMTRACE_ENDPOINT", raising=False)
    return saved


def test_sync_trace_saved(records):
    @tracer.observe
    def add(a, b):
        return a + b

    assert add(2, 3) == 5
    assert len(records) == 1
    row = records[0]
    assert row[2] == "add"      # function name
    assert row[4] == "5"        # output
    assert row[6] is None       # no error
    assert len(row[0]) == 32    # full uuid4 hex — collision-safe


def test_parent_child_linkage(records):
    @tracer.observe
    def child():
        return "c"

    @tracer.observe
    def parent():
        child()
        return "p"

    parent()
    child_row = next(r for r in records if r[2] == "child")
    parent_row = next(r for r in records if r[2] == "parent")
    assert child_row[1] == parent_row[0]
    assert parent_row[1] is None


def test_error_captured_and_reraised(records):
    @tracer.observe
    def boom():
        raise ValueError("nope")

    with pytest.raises(ValueError):
        boom()
    assert records[0][6] == "nope"


def test_flush_failure_never_masks_user_exception(records, monkeypatch):
    monkeypatch.setattr(
        tracer, "_flush", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db down"))
    )

    @tracer.observe
    def boom():
        raise ValueError("the real error")

    with pytest.raises(ValueError, match="the real error"):
        boom()


def test_async_trace_saved(records):
    @tracer.observe
    async def aadd(a, b):
        return a + b

    assert asyncio.run(aadd(1, 2)) == 3
    assert len(records) == 1
    assert records[0][2] == "aadd"
    assert records[0][4] == "3"


# ---------------------------------------------------------------------------
# kind / agent attribution
# ---------------------------------------------------------------------------

def test_default_kind_is_agent_and_self_attributed(records):
    @tracer.observe
    def my_agent():
        return "ok"

    my_agent()
    kind, agent_id, agent_name = records[0][-3:]
    assert kind == "agent"
    assert agent_id == records[0][0]      # attributed to itself
    assert agent_name == "my_agent"


def test_nested_tool_and_llm_calls_attribute_to_enclosing_agent(records):
    @tracer.observe(kind="llm")
    def call_llm(prompt):
        return "llm output"

    @tracer.observe(kind="tool")
    def search_web(q):
        return "tool output"

    @tracer.observe
    def orchestrator(q):
        call_llm(q)
        search_web(q)
        return "done"

    orchestrator("hello")

    by_func = {r[2]: r for r in records}
    orch_id = by_func["orchestrator"][0]

    # Nested llm/tool spans roll up into the orchestrator's agent identity.
    assert by_func["call_llm"][-3] == "llm"
    assert by_func["call_llm"][-2] == orch_id
    assert by_func["call_llm"][-1] == "orchestrator"

    assert by_func["search_web"][-3] == "tool"
    assert by_func["search_web"][-2] == orch_id
    assert by_func["search_web"][-1] == "orchestrator"

    # The orchestrator itself is its own agent.
    assert by_func["orchestrator"][-3] == "agent"
    assert by_func["orchestrator"][-2] == orch_id
    assert by_func["orchestrator"][-1] == "orchestrator"


def test_nested_agents_each_get_their_own_agent_id(records):
    @tracer.observe
    def researcher(q):
        return "research"

    @tracer.observe
    def summarizer(text):
        return "summary"

    @tracer.observe
    def orchestrator(q):
        researcher(q)
        return summarizer("x")

    orchestrator("What is AGI?")

    by_func = {r[2]: r for r in records}

    # Each is its own agent, with its own agent_id == its own trace id.
    for name in ("orchestrator", "researcher", "summarizer"):
        kind, agent_id, agent_name = by_func[name][-3:]
        assert kind == "agent"
        assert agent_id == by_func[name][0]
        assert agent_name == name

    # researcher/summarizer are nested under orchestrator (parent_id),
    # but each is still its own agent identity, not orchestrator's.
    assert by_func["researcher"][1] == by_func["orchestrator"][0]
    assert by_func["researcher"][-2] != by_func["orchestrator"][-2]


def test_orphan_tool_call_self_attributes_but_is_not_an_agent(records):
    @tracer.observe(kind="tool")
    def standalone_tool():
        return "ok"

    standalone_tool()
    kind, agent_id, agent_name = records[0][-3:]
    assert kind == "tool"
    assert agent_id == records[0][0]      # falls back to self
    assert agent_name == "standalone_tool"


def test_invalid_kind_rejected():
    with pytest.raises(ValueError):
        @tracer.observe(kind="bogus")
        def f():
            ...


def test_async_kind_and_agent_attribution(records):
    @tracer.observe(kind="llm")
    async def acall_llm(prompt):
        return "out"

    @tracer.observe
    async def aorchestrator(q):
        await acall_llm(q)
        return "done"

    asyncio.run(aorchestrator("hi"))

    by_func = {r[2]: r for r in records}
    orch_id = by_func["aorchestrator"][0]

    assert by_func["aorchestrator"][-3] == "agent"
    assert by_func["acall_llm"][-3] == "llm"
    assert by_func["acall_llm"][-2] == orch_id
    assert by_func["acall_llm"][-1] == "aorchestrator"
