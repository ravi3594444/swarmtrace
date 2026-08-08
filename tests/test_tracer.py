"""Tests for the @observe decorator (sync, async, linkage, errors)."""

import asyncio

import pytest

from swarmtrace import tracer

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
        saved.append((
            span.span_id, span.parent_span_id, span.name, span.args, span.output,
            span.latency_sec, span.error, span.start_time.isoformat(),
            span.input_tokens, span.output_tokens, span.cost_usd,
            span.kind, span.agent_id, span.agent_name, span.session_id,
        ))

    monkeypatch.setattr(fake_runtime.repository, "save", _capture)
    return saved


@pytest.fixture()
def payloads(monkeypatch, fake_runtime):
    """Capture payloads as they are enqueued by the runtime sender."""
    captured = []
    original_enqueue = fake_runtime.sender.enqueue

    def _capture_enqueue(payload):
        captured.append(payload)
        original_enqueue(payload)

    monkeypatch.setattr(fake_runtime.sender, "enqueue", _capture_enqueue)
    return captured


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


def test_explicit_session_id_is_saved(records):
    @tracer.observe(session_id="conv-1")
    def chat():
        return "ok"

    chat()
    assert records[0][14] == "conv-1"


def test_session_context_propagates_to_nested_calls_and_payload(records, payloads):
    @tracer.observe
    def child():
        return "child"

    @tracer.observe
    def parent():
        child()
        return "parent"

    with tracer.session("thread-1"):
        parent()

    child_row = next(r for r in records if r[2] == "child")
    parent_row = next(r for r in records if r[2] == "parent")
    assert child_row[14] == "thread-1"
    assert parent_row[14] == "thread-1"
    assert child_row[1] == parent_row[0]
    assert [p["session_id"] for p in payloads] == ["thread-1", "thread-1"]


def test_nested_session_restores_outer_on_exit(records):
    @tracer.observe
    def ping():
        return "ok"

    with tracer.session("outer"):
        ping()
        with tracer.session("inner"):
            ping()
        ping()

    assert [row[14] for row in records] == ["outer", "inner", "outer"]


def test_call_without_session_has_none(records):
    @tracer.observe
    def plain():
        return "ok"

    plain()
    assert records[0][14] is None


# ---------------------------------------------------------------------------
# kind / agent attribution
# ---------------------------------------------------------------------------

def test_default_kind_is_agent_and_self_attributed(records):
    @tracer.observe
    def my_agent():
        return "ok"

    my_agent()
    kind, agent_id, agent_name = records[0][-4:-1]
    assert kind == "agent"
    # Bare @observe at top level now gets a STABLE agent_id derived from the
    # function's qualified name, so repeat runs aggregate into one dashboard
    # agent card. The id is no longer equal to the row's own trace id.
    import hashlib
    expected = hashlib.sha256(
        f"{my_agent.__module__}.{my_agent.__qualname__}".encode()
    ).hexdigest()
    assert agent_id == expected
    assert agent_id != records[0][0]   # stable id, NOT the fresh trace id
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
    # orch_id is the orchestrator's agent_id (position -2), NOT its row id
    # (position 0). The orchestrator is a bare @observe, so its agent_id is
    # now a stable hash; nested spans inherit it via the enclosing-agent
    # context. Reading from position -2 keeps this test correct regardless
    # of how agent_id is derived.
    orch_id = by_func["orchestrator"][-3]

    # Nested llm/tool spans roll up into the orchestrator's agent identity.
    assert by_func["call_llm"][-4] == "llm"
    assert by_func["call_llm"][-3] == orch_id
    assert by_func["call_llm"][-2] == "orchestrator"

    assert by_func["search_web"][-4] == "tool"
    assert by_func["search_web"][-3] == orch_id
    assert by_func["search_web"][-2] == "orchestrator"

    # The orchestrator itself is its own agent.
    assert by_func["orchestrator"][-4] == "agent"
    assert by_func["orchestrator"][-3] == orch_id
    assert by_func["orchestrator"][-2] == "orchestrator"


def test_nested_agents_each_get_their_own_agent_id(records):
    """Multi-agent: each sub-agent uses explicit kind="agent" so it gets its
    own dashboard card. Bare @observe on orchestrator resolves to "agent"
    since nothing is running yet when it starts."""

    @tracer.observe(kind="agent")
    def researcher(q):
        return "research"

    @tracer.observe(kind="agent")
    def summarizer(text):
        return "summary"

    @tracer.observe           # auto → "agent" (top of call stack)
    def orchestrator(q):
        researcher(q)
        return summarizer("x")

    orchestrator("What is AGI?")

    by_func = {r[2]: r for r in records}

    # Each is its own agent with its own agent_id.
    # - orchestrator: bare @observe → STABLE hash id (NOT its row id)
    # - researcher/summarizer: explicit kind="agent" → fresh trace id (== row id)
    import hashlib
    orch_expected = hashlib.sha256(
        f"{orchestrator.__module__}.{orchestrator.__qualname__}".encode()
    ).hexdigest()

    kind, orch_aid, orch_aname = by_func["orchestrator"][-4:-1]
    assert kind == "agent"
    assert orch_aid == orch_expected            # stable hash
    assert orch_aid != by_func["orchestrator"][0]  # NOT the row id
    assert orch_aname == "orchestrator"

    for name in ("researcher", "summarizer"):
        kind, agent_id, agent_name = by_func[name][-4:-1]
        assert kind == "agent"
        assert agent_id == by_func[name][0]     # explicit kind="agent" → fresh trace id
        assert agent_name == name

    # researcher/summarizer are nested under orchestrator (parent_id),
    # but each is still its own agent identity, not orchestrator's.
    assert by_func["researcher"][1] == by_func["orchestrator"][0]
    assert by_func["researcher"][-3] != by_func["orchestrator"][-3]


def test_orphan_tool_call_self_attributes_but_is_not_an_agent(records):
    @tracer.observe(kind="tool")
    def standalone_tool():
        return "ok"

    standalone_tool()
    kind, agent_id, agent_name = records[0][-4:-1]
    assert kind == "tool"
    assert agent_id == records[0][0]      # falls back to self
    assert agent_name == "standalone_tool"


def test_invalid_kind_rejected():
    with pytest.raises(ValueError):
        @tracer.observe(kind="bogus")
        def f():
            ...


def test_retrieval_kind_accepted_by_observe(records):
    """Regression: @observe(kind="retrieval") must NOT raise.

    The Phase 3 RAG effort added 'retrieval' to the MCP route's Zod enum
    (frontend-next/app/api/mcp/route.ts), to resolve-trace-identity.ts's
    TraceKind union, to scraper.scrape(kind="retrieval"), and to the
    integration test test_phase3_retrieval_kind_round_trips — but never
    to the Python SDK's canonical _VALID_KINDS in tracer.py. So the
    primary entry point (@observe) raised ValueError on the very kind
    the docs and the rest of the stack already endorsed. Same taxonomy,
    three different rules. This test locks @observe in step with the
    other entry points.

    Attribution follows the established house pattern: a bare
    @observe(kind=...) with no enclosing agent falls back to its own
    identity, so agent_id == trace_id (mirrors
    test_orphan_tool_call_self_attributes_but_is_not_an_agent and
    test_explicit_kind_agent_keeps_fresh_id_across_runs). We assert the
    resolved kind is persisted and the row is non-agent (no phantom
    agent card is created for a retrieval span on its own).
    """
    @tracer.observe(kind="retrieval")
    def rag_search(query):
        return f"docs about {query}"

    rag_search("qdrant")

    assert len(records) == 1
    kind, agent_id, agent_name = records[0][-4:-1]
    assert kind == "retrieval"
    # No enclosing agent → falls back to self (the row's own trace_id),
    # matching the orphan-tool-call pattern. agent_id == trace_id (pos 0).
    assert agent_id == records[0][0]
    assert agent_name == "rag_search"


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
    # aorchestrator is a bare @observe → stable agent_id (position -2),
    # NOT its row id (position 0). Read from -2 to stay correct.
    orch_id = by_func["aorchestrator"][-3]

    assert by_func["aorchestrator"][-4] == "agent"
    assert by_func["acall_llm"][-4] == "llm"
    assert by_func["acall_llm"][-3] == orch_id
    assert by_func["acall_llm"][-2] == "aorchestrator"


# ---------------------------------------------------------------------------
# stable agent_id for bare @observe (the fix for "every run looks like a new
# agent"). These lock in the new contract: repeat runs of the same top-level
# @observe entrypoint aggregate into one agent identity on the dashboard.
# ---------------------------------------------------------------------------

def test_bare_observe_stable_agent_id_across_runs(records):
    """Two calls to the same bare @observe function must share agent_id so
    the dashboard shows one agent card with tasks=2, not two cards with
    tasks=1 each."""
    @tracer.observe
    def my_entrypoint():
        return "ok"

    my_entrypoint()
    my_entrypoint()

    assert len(records) == 2
    # Different trace ids (each call is its own span)...
    assert records[0][0] != records[1][0]
    # ...but the SAME agent_id (stable identity for the entrypoint).
    assert records[0][-3] == records[1][-3]
    assert records[0][-2] == "my_entrypoint"


def test_explicit_kind_agent_keeps_fresh_id_across_runs(records):
    """Explicit @observe(kind="agent") keeps a fresh agent_id per call —
    swarm sub-agents within separate runs should NOT collapse."""
    @tracer.observe(kind="agent")
    def sub_agent():
        return "ok"

    sub_agent()
    sub_agent()

    assert len(records) == 2
    # Fresh trace id AND fresh agent_id per call.
    assert records[0][0] != records[1][0]
    assert records[0][-3] != records[1][-3]
    assert records[0][-3] == records[0][0]   # explicit kind="agent" → agent_id == trace_id


def test_observe_name_overrides_agent_name_and_seeds_id(records):
    """name= overrides the displayed agent_name AND seeds the stable hash,
    so two distinct names produce two distinct (but each stable) agent ids."""
    @tracer.observe(name="alice_bot")
    def entrypoint_a():
        return "a"

    @tracer.observe(name="bob_bot")
    def entrypoint_b():
        return "b"

    entrypoint_a()
    entrypoint_a()
    entrypoint_b()

    by_func = {r[2]: r for r in records}
    import hashlib

    a_id = by_func["entrypoint_a"][-3]
    a_name = by_func["entrypoint_a"][-2]
    b_id = by_func["entrypoint_b"][-3]

    # name= overrides the displayed agent_name.
    assert a_name == "alice_bot"
    # name= seeds the stable hash (deterministic).
    assert a_id == hashlib.sha256(b"alice_bot").hexdigest()
    # Different name → different stable id.
    assert b_id == hashlib.sha256(b"bob_bot").hexdigest()
    assert a_id != b_id
    # Repeat run of entrypoint_a shares the same stable id.
    a_rows = [r for r in records if r[2] == "entrypoint_a"]
    assert len(a_rows) == 2
    assert a_rows[0][-3] == a_rows[1][-3]


# ---------------------------------------------------------------------------
# Lambda disambiguation.
#
# All lambdas share the qualname '<lambda>' (or 'outer.<locals>.<lambda>'),
# so two distinct lambdas in the same scope used to hash to the SAME
# agent_id and silently collapse into one dashboard card. The fix appends
# the source line number to the hash source when '<lambda>' appears in
# the qualname — stable across calls of the same lambda (so repeat runs
# still aggregate) but differing between distinct lambdas (so they don't
# collide). These tests lock in both halves of that contract.
# ---------------------------------------------------------------------------

def test_distinct_lambdas_get_distinct_agent_ids(records):
    """Two distinct lambdas (different source lines) must NOT collide
    into one agent card. Pre-fix this silently merged them."""
    bot_a = tracer.observe(lambda x: "a")
    bot_b = tracer.observe(lambda x: "b")

    bot_a("q1")
    bot_b("q2")

    assert len(records) == 2
    a_id = records[0][-3]
    b_id = records[1][-3]
    assert a_id != b_id, (
        "distinct lambdas collapsed into one agent_id — "
        "the dashboard would show one card instead of two"
    )


def test_same_lambda_called_twice_aggregates(records):
    """Repeat calls of the SAME lambda must share agent_id (the whole
    point of the stable-id fix). Line-number disambiguation must not
    break this — the same lambda is on the same line by definition."""
    bot = tracer.observe(lambda x: f"answer to {x}")

    bot("q1")
    bot("q2")
    bot("q3")

    assert len(records) == 3
    # Different trace ids per call...
    ids = {r[0] for r in records}
    assert len(ids) == 3
    # ...but the same agent_id (stable identity for this lambda).
    agent_ids = {r[-3] for r in records}
    assert len(agent_ids) == 1, (
        f"same lambda got {len(agent_ids)} distinct agent_ids — "
        "repeat runs would not aggregate"
    )


def test_lambda_with_name_override_uses_name_not_lineno(records):
    """name= takes precedence over the qualname+lineno derivation.
    Two lambdas with different names get different ids via name hash,
    not via line number."""
    bot_a = tracer.observe(lambda x: "a", name="alice")
    bot_b = tracer.observe(lambda x: "b", name="bob")

    bot_a(0)
    bot_b(0)

    import hashlib
    assert records[0][-3] == hashlib.sha256(b"alice").hexdigest()
    assert records[1][-3] == hashlib.sha256(b"bob").hexdigest()
    assert records[0][-2] == "alice"
    assert records[1][-2] == "bob"


def test_named_function_unaffected_by_lambda_disambiguation(records):
    """Named functions must NOT include the source line number in the
    hash source — refactoring (moving a function to a different line)
    must not break agent aggregation. This is the regression guard
    against accidentally applying the lambda fix to all functions."""
    @tracer.observe
    def my_named_agent():
        return "ok"

    my_named_agent()

    import hashlib
    expected = hashlib.sha256(
        f"{my_named_agent.__module__}.{my_named_agent.__qualname__}".encode()
    ).hexdigest()
    # No '@lineno' suffix — named functions keep the original derivation.
    assert records[0][-3] == expected
    assert "@" not in records[0][-3]  # paranoid check: id is pure hex


def test_distinct_lambdas_in_same_outer_function_get_distinct_ids(records):
    """Two lambdas defined inside the SAME outer function share the
    qualname 'outer.<locals>.<lambda>' — the most common collision
    case. The line-number fix must disambiguate them too."""

    def make_bots():
        # Defined on different source lines → different co_firstlineno.
        bot_first = tracer.observe(lambda x: "first")
        bot_second = tracer.observe(lambda x: "second")
        return bot_first, bot_second

    bot_first, bot_second = make_bots()
    bot_first(0)
    bot_second(0)

    assert len(records) == 2
    assert records[0][-3] != records[1][-3], (
        "two lambdas in the same outer function still collide"
    )


# ---------------------------------------------------------------------------
# SDK ↔ API contract test
#
# /api/agents/route.ts groups traces by agent_id and filters groups that
# contain at least one kind='agent' span. This test reproduces that exact
# filter logic against real tracer output, so a change to EITHER the SDK's
# agent_id assignment OR the API's filter logic that breaks the contract
# fails here instead of silently breaking the dashboard.
#
# The old API filter also checked `t.id === agent_id` — an artifact of the
# old `agent_id = trace_id` invariant. That check was removed because it
# drops every bare-@observe agent under the stable-id scheme. This test
# guards against re-introducing it.
# ---------------------------------------------------------------------------

def _row_dict(t):
    """Convert a save_trace positional-args tuple to the dict shape the API
    receives from Supabase."""
    (id_, parent_id, func, args, _output, _lat, err, ts, _in_t, _out_t, _cost,
     kind, agent_id, agent_name, _session_id) = t
    return {
        "id": id_, "parent_id": parent_id, "function": func,
        "agent_id": agent_id, "agent_name": agent_name, "kind": kind,
        "timestamp": ts, "error": err, "args": args,
    }


def _api_agents_filter(rows):
    """Reproduce the EXACT logic of /api/agents/route.ts.

    Returns a list of {id, name, tasks} for each agent card the dashboard
    would show. If this returns the wrong cards (or zero cards), the
    dashboard is broken."""
    # Group by agent_id (route.ts: rows.forEach groups[r.agent_id] ||= [])
    groups = {}
    for r in rows:
        groups.setdefault(r["agent_id"], []).append(r)

    # Filter + map (route.ts: .filter(...).map(...))
    agents = []
    for aid, traces in groups.items():
        # The filter: group is an agent iff it has a kind='agent' span.
        # (DO NOT add `and t['id'] == aid` — see contract docstring above.)
        if not any(t["kind"] == "agent" for t in traces):
            continue
        runs = [t for t in traces if t["kind"] == "agent"]
        agents.append({
            "id": aid,
            "name": runs[0]["agent_name"],
            "tasks": len(runs),
        })
    return agents


def test_api_agents_filter_contract(records):
    """End-to-end: real tracer output → API filter → expected agent cards.

    Covers all four agent_id regimes:
      1. Bare @observe, multiple runs → ONE card, tasks=N (stable id)
      2. Explicit kind='agent' swarm → separate cards, tasks=1 each (fresh id)
      3. Nested non-agent spans → roll up into enclosing agent's card
      4. Orphan tool call → NO card (phantom prevention)
    """

    @tracer.observe(kind="agent")
    def researcher():
        return "r"

    @tracer.observe(kind="agent")
    def summarizer():
        return "s"

    @tracer.observe
    def orchestrator(q):
        researcher()
        return summarizer()

    @tracer.observe
    def my_bot():
        return "ok"

    @tracer.observe(kind="tool")
    def standalone_tool():
        return "orphan"

    # 3 runs of my_bot (should aggregate into 1 card, tasks=3)
    my_bot()
    my_bot()
    my_bot()

    # 1 run of orchestrator (calls 2 explicit sub-agents)
    orchestrator("q")

    # 1 orphan tool call (should NOT become a card)
    standalone_tool()

    rows = [_row_dict(t) for t in records]
    cards = _api_agents_filter(rows)

    by_name = {c["name"]: c for c in cards}

    # 1. my_bot: one card, tasks=3 (the whole point of the stable-id fix)
    assert "my_bot" in by_name, f"my_bot card missing! cards={cards}"
    assert by_name["my_bot"]["tasks"] == 3, \
        f"expected tasks=3, got {by_name['my_bot']['tasks']}"

    # 2. orchestrator: one card, tasks=1
    assert "orchestrator" in by_name
    assert by_name["orchestrator"]["tasks"] == 1

    # 3. researcher + summarizer: separate cards, tasks=1 each
    assert "researcher" in by_name
    assert by_name["researcher"]["tasks"] == 1
    assert "summarizer" in by_name
    assert by_name["summarizer"]["tasks"] == 1

    # 4. orphan tool: NO card (phantom prevention)
    assert "standalone_tool" not in by_name, \
        f"phantom agent! standalone_tool should not be a card. cards={cards}"

    # Total: 4 agent cards (my_bot, orchestrator, researcher, summarizer)
    assert len(cards) == 4, f"expected 4 cards, got {len(cards)}: {cards}"


# ── Audit finding #3: args_repr must be capped to match output ──────────────
#
# Before the fix, _flush did:
#     args_repr = str(args[:2])           # no cap
#     output    = _safe_str(result)       # capped at 32000
# This asymmetry meant a function called with one big argument (large string,
# dataframe repr, etc.) produced a trace whose args field was unbounded while
# output was exactly 32000 chars. Downstream: the oversized row could push its
# batch over the server's MAX_BODY_BYTES = 64KB → 413 → resync() retries the
# row forever (it never fits), never marks it synced=1, and it silently leaks
# in the local SQLite DB forever while burning retry time on every resync run.
#
# The fix routes args_repr through _safe_str too, so both fields cap at 32000.
# These tests guard the cap directly.

def test_args_repr_capped_at_32000_chars(records):
    """A single huge argument must not produce an unbounded args field."""
    @tracer.observe
    def f(big_arg):
        return "ok"

    big = "X" * 200_000
    f(big)

    assert len(records) == 1
    args_repr = records[0][3]   # save_trace(trace_id, parent_id, func_name, args_repr, ...)
    # Cap is 32000, matching _safe_str's default. We don't assert exact equality
    # because redact() may add/remove a few chars after the cap is applied —
    # but it must be in the same order of magnitude as the output cap, NOT
    # the unbounded 200,005 chars the bug produced.
    assert len(args_repr) <= 33000, \
        f"args_repr not capped: {len(args_repr)} chars (expected <= ~33000)"
    assert len(args_repr) >= 31000, \
        f"args_repr suspiciously short: {len(args_repr)} chars (expected ~32000)"


def test_args_and_output_caps_are_symmetric(records):
    """The whole point of finding #3: args and output must cap at the same
    length. Before the fix, args was unbounded and output was 32000 — that
    asymmetry is the bug."""
    @tracer.observe
    def f(big_arg):
        return big_arg   # returns the same huge string

    big = "Y" * 200_000
    f(big)

    assert len(records) == 1
    args_repr = records[0][3]
    output    = records[0][4]
    # Both should be capped to ~32000 — within a small tolerance for redact()
    # post-processing. The bug would show args at ~200,005 and output at 32,000.
    assert abs(len(args_repr) - len(output)) <= 200, \
        f"asymmetry! args={len(args_repr)}, output={len(output)} " \
        f"(diff={len(args_repr) - len(output)})"


def test_kwargs_keys_appended_after_args_cap(records):
    """The kwargs list is appended AFTER the cap is applied — make sure that
    still works and doesn't blow past the cap by more than a reasonable
    amount (the kwargs keys themselves are short, just names)."""
    @tracer.observe
    def f(big_arg, **kwargs):
        return "ok"

    big = "Z" * 200_000
    f(big, alpha=1, beta=2, gamma=3)

    assert len(records) == 1
    args_repr = records[0][3]
    # Cap (32000) + " kwargs=['alpha', 'beta', 'gamma']" suffix is well under 34KB.
    # Before the fix this would have been 200,005 + suffix.
    assert len(args_repr) < 34000, \
        f"args_repr with kwargs not capped: {len(args_repr)} chars"
    # The kwargs names should still be visible (they're metadata, not PII).
    assert "alpha" in args_repr
    assert "beta" in args_repr
    assert "gamma" in args_repr


def test_small_args_unaffected_by_cap(records):
    """Normal-sized args should pass through unchanged — the cap is a ceiling,
    not a fixed length. Make sure we didn't accidentally pad or alter them."""
    @tracer.observe
    def add(a, b):
        return a + b

    add(2, 3)

    assert len(records) == 1
    args_repr = records[0][3]
    assert "(2, 3)" in args_repr
    assert len(args_repr) < 100  # small args → small repr


# ── Audit finding #5: scheme enforcement on SWARMTRACE_ENDPOINT ────────────
#
# Before the fix, _normalize_base_url accepted any string, so
# SWARMTRACE_ENDPOINT=http://example.com would silently send the API key
# over plaintext HTTP with zero warning.
#
# The fix adds _validate_endpoint_scheme(url) → (ok, reason) and has
# _remote_config refuse to return a non-empty URL when the scheme is
# insecure. The worker then skips sending (matching the "no endpoint
# configured" path) instead of leaking the key.

from swarmtrace.tracer import _remote_config, _validate_endpoint_scheme


def test_validate_endpoint_empty_is_ok():
    """Empty URL means 'no endpoint configured' — not a security issue."""
    ok, reason = _validate_endpoint_scheme("")
    assert ok is True
    assert reason == ""


def test_validate_endpoint_https_any_host_allowed():
    """https:// is always safe regardless of host."""
    ok, _ = _validate_endpoint_scheme("https://example.com")
    assert ok is True
    ok, _ = _validate_endpoint_scheme("https://swarmtrace.vercel.app/api/")
    assert ok is True
    ok, _ = _validate_endpoint_scheme("https://1.2.3.4:8443")
    assert ok is True


def test_validate_endpoint_http_localhost_allowed():
    """http:// to localhost variants is allowed for local dev / testing."""
    for url in [
        "http://localhost",
        "http://localhost:3000",
        "http://127.0.0.1",
        "http://127.0.0.1:8000",
        "http://[::1]:8000",   # IPv6 localhost
    ]:
        ok, reason = _validate_endpoint_scheme(url)
        assert ok is True, f"expected {url} to be ok, got: {reason}"


def test_validate_endpoint_http_external_rejected():
    """http:// to non-localhost hosts must be rejected — that's the bug."""
    ok, reason = _validate_endpoint_scheme("http://example.com")
    assert ok is False
    assert "plaintext" in reason.lower() or "http" in reason.lower()


def test_validate_endpoint_http_rfc1918_rejected():
    """RFC1918 IPs (192.168.x.x, 10.x.x.x) are NOT localhost — reject.

    These are often used for internal services that may not be as trusted
    as a dev loopback. Users who need them can set up HTTPS locally."""
    for url in [
        "http://192.168.1.5",
        "http://192.168.1.5:8000",
        "http://10.0.0.1",
        "http://172.16.0.1",
    ]:
        ok, reason = _validate_endpoint_scheme(url)
        assert ok is False, f"expected {url} to be rejected, got ok=True"
        assert "plaintext" in reason.lower() or "non-localhost" in reason.lower()


def test_validate_endpoint_other_schemes_rejected():
    """ftp://, file://, etc. are nonsense for an API endpoint — reject."""
    for url in [
        "ftp://example.com",
        "file:///etc/passwd",
        "ws://example.com",
    ]:
        ok, reason = _validate_endpoint_scheme(url)
        assert ok is False, f"expected {url} to be rejected"
        assert "scheme" in reason.lower()


def test_validate_endpoint_no_scheme_rejected():
    """A bare hostname with no scheme is ambiguous — reject (defensive)."""
    ok, reason = _validate_endpoint_scheme("example.com")
    assert ok is False
    assert "scheme" in reason.lower()


def test_validate_endpoint_reason_is_human_readable():
    """The reason string should explain WHAT to do, not just that it failed."""
    ok, reason = _validate_endpoint_scheme("http://example.com")
    assert ok is False
    # Should mention https or localhost as the fix.
    assert "https" in reason.lower() or "localhost" in reason.lower()


def test_remote_config_returns_empty_url_for_insecure_endpoint(monkeypatch):
    """When the scheme is insecure, _remote_config returns empty URL so the
    worker skips sending — that's the actual security property: the API
    key never goes over the wire."""
    monkeypatch.setenv("SWARMTRACE_API_KEY", "sk_test_abc")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "http://example.com")
    # Clear any module-level override
    monkeypatch.setattr(tracer, "_api_key", None)
    monkeypatch.setattr(tracer, "_endpoint", None)

    key, url = _remote_config()
    assert key == "sk_test_abc"  # key is still returned (for logging)
    assert url == "", f"expected empty URL, got {url!r}"


def test_remote_config_returns_url_for_secure_endpoint(monkeypatch):
    """Happy path: https URL is normalized and returned."""
    monkeypatch.setenv("SWARMTRACE_API_KEY", "sk_test_abc")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "https://swarmtrace.vercel.app/api/")
    monkeypatch.setattr(tracer, "_api_key", None)
    monkeypatch.setattr(tracer, "_endpoint", None)

    key, url = _remote_config()
    assert key == "sk_test_abc"
    assert url == "https://swarmtrace.vercel.app"  # trailing / and /api stripped


def test_remote_config_returns_url_for_localhost_dev(monkeypatch):
    """Localhost dev case still works — the explicit escape hatch."""
    monkeypatch.setenv("SWARMTRACE_API_KEY", "sk_test_abc")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "http://localhost:3000/api")
    monkeypatch.setattr(tracer, "_api_key", None)
    monkeypatch.setattr(tracer, "_endpoint", None)

    key, url = _remote_config()
    assert key == "sk_test_abc"
    assert url == "http://localhost:3000"


# ── Audit finding #9: _normalize_base_url edge cases ────────────────────────
#
# The four documented patterns (bare, trailing /, /api, /api/) were always
# handled correctly. These cover the cases that were NOT: repeated slashes
# immediately before the /api suffix leaving a stray trailing slash behind,
# an uppercase (or mixed-case) /API suffix not being recognized at all
# (str.endswith is case-sensitive), and surrounding whitespace from a
# copy-pasted or heredoc-set env var not being trimmed.

from swarmtrace.tracer import _normalize_base_url


def test_normalize_base_url_four_documented_patterns_unaffected():
    """The fix must not regress the original four supported forms."""
    assert _normalize_base_url("https://app.vercel.app") == "https://app.vercel.app"
    assert _normalize_base_url("https://app.vercel.app/") == "https://app.vercel.app"
    assert _normalize_base_url("https://app.vercel.app/api") == "https://app.vercel.app"
    assert _normalize_base_url("https://app.vercel.app/api/") == "https://app.vercel.app"


def test_normalize_base_url_repeated_slash_before_api_suffix():
    """A doubled slash right before /api (plausible copy-paste typo) used
    to leave one stray trailing slash after stripping the suffix."""
    assert _normalize_base_url("https://example.com//api//") == "https://example.com"
    assert _normalize_base_url("https://example.com//api") == "https://example.com"


def test_normalize_base_url_uppercase_api_suffix_recognized():
    """/API (or any other casing) used to survive untouched, producing a
    doubled path like '.../API/api/ingest' once a caller appended the
    real route."""
    assert _normalize_base_url("https://app.vercel.app/API") == "https://app.vercel.app"
    assert _normalize_base_url("https://app.vercel.app/Api/") == "https://app.vercel.app"
    assert _normalize_base_url("https://example.com/API//") == "https://example.com"


def test_normalize_base_url_surrounding_whitespace_trimmed():
    assert _normalize_base_url("  https://example.com/api  ") == "https://example.com"
    assert _normalize_base_url("https://example.com/api\n") == "https://example.com"


def test_normalize_base_url_legit_path_ending_in_api_only_stripped_once():
    """A real path that legitimately ends in '/api' as part of a reverse
    proxy setup (e.g. '.../rest/api') only has the ONE trailing '/api'
    stripped, not repeatedly — matches the pre-fix behavior for this case,
    the fix doesn't change it."""
    assert _normalize_base_url("https://example.com/rest/api") == "https://example.com/rest"


def test_normalize_base_url_short_strings_do_not_crash():
    """Degenerate short inputs (shorter than the '/api' suffix) must not
    raise from the negative-index slice."""
    assert _normalize_base_url("") == ""
    assert _normalize_base_url("a") == "a"
    assert _normalize_base_url("api") == "api"  # no leading slash — not the suffix
    assert _normalize_base_url("/api") == ""
    assert _normalize_base_url("/API") == ""


def test_normalize_base_url_whitespace_only_returns_empty():
    """Whitespace-only URLs must not IndexError on the trailing-/api slice."""
    assert _normalize_base_url("   ") == ""
    assert _normalize_base_url("\t\n") == ""
    assert _normalize_base_url("///") == ""
