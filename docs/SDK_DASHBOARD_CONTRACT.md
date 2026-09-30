# SDK and dashboard contract: `agent_id` and `kind`

This describes how the Python SDK, the MCP route and the Next.js dashboard agree
on what counts as one agent and one run. The rules are implemented in
`tracer.py`, `derive-agent-cards.ts` and `stable-agent-id.ts`. If you change any
file under "Where each rule lives", update this doc in the same commit.

## Summary

A trace row belongs to an agent card when its `agent_id` matches at least one
other row with `kind == "agent"` in the same group. `agent_id` is either a random
per-call id (swarm sub-agents) or a stable SHA-256 hash of the agent's identity
(bare `@observe` entry points and MCP calls), so repeat runs of the same agent
collapse into one card.

## `kind`

Valid values are `"agent"`, `"tool"`, `"llm"`, `"function"`, `"retrieval"`, and
`"auto"`. `"auto"` is an SDK-only input that is resolved before saving
(`tracer.py::_resolve_kind`):

```
resolved_kind = kind if kind != "auto" else (
    "agent" if there is no enclosing agent span else "function"
)
```

A bare `@observe` call becomes `kind="agent"` only when it isn't nested inside
another traced call; otherwise it is `"function"`. An explicit
`@observe(kind=...)` always keeps the kind you pass.

`"retrieval"` is for document loading and vector search spans (qdrant, pinecone,
chroma lookups, `scraper.scrape(kind="retrieval")`). Like `"tool"`, `"llm"` and
`"function"` it is a leaf kind: it is never auto-resolved to, never becomes an
agent card, and needs an `agent_id` when recorded through the stateless MCP
route (see `lib/resolve-trace-identity.ts`).

The same kind set must be accepted in four places: `@observe`
(`tracer.py::_VALID_KINDS`), `scraper.scrape(kind=...)`, the MCP `record_trace`
Zod enum (`app/api/mcp/route.ts`), and the dashboard's `TraceKind` union
(`lib/resolve-trace-identity.ts`).

An orphan `tool`, `llm`, `function` or `retrieval` call with no enclosing agent
keeps its own kind. The SDK only assigns `kind="agent"` to the auto-resolved
top-level span, so `deriveAgentCards` can group on "has at least one
`kind == 'agent'` row" without checking for orphans separately.

## `agent_id`

| Case | `agent_id` | Reason |
|---|---|---|
| Bare `@observe` (resolved to `kind="agent"`) | `sha256(f"{module}.{qualname}")`, or `sha256(name)` if `name=` was passed (64 hex chars) | Runs of the same top-level function share one card |
| Explicit `@observe(kind="agent")` | fresh random `trace_id` per call | Swarm sub-agents in one parent run stay separate cards |
| MCP `record_trace` without `agent_id` | `sha256(function_name)` via `stable-agent-id.ts` | Same algorithm as the SDK, so MCP calls aggregate the same way |

`stable-agent-id.ts::stableAgentId` is a TypeScript port of
`tracer.py::_stable_agent_id`. Both must hash the same input string to the same
digest, or MCP and SDK traces for the same agent show up as two cards. There is no
cross-language hash test. If you change how the hash input is built on one side,
change the other.

Known limitations: two lambdas on the same source line collide, and so do
closures from the same factory function unless you pass `name=`.

### Don't re-add `t.id === agent_id`

`derive-agent-cards.ts` must not filter groups on `t.id === agent_id`. That was
only true when `agent_id` always equalled the trace's own id. With stable ids,
`agent_id` is a hash shared by many traces, so the check would drop every bare
`@observe` run. This is covered by
`tests/test_tracer.py::test_api_agents_filter_contract` and the `REGRESSION GUARD`
test in `scripts/test-derive-agent-cards.mjs`.

## Latest-run selection

`deriveAgentCards` sorts each group by `timestamp` descending before choosing the
latest run or event, so it doesn't depend on the caller's ordering. The caller
(`app/api/agents/route.ts` via `lib/trace-query.ts`) also sorts in the query, for
pagination. See the `SORT GUARD` tests in `scripts/test-derive-agent-cards.mjs`.

## Where each rule lives

| Rule | Source | Tests |
|---|---|---|
| `kind` resolution (`auto` to `agent`/`function`) | `swarmtrace/tracer.py::_resolve_kind` | `tests/test_tracer.py` |
| Accepted `kind` set | `swarmtrace/tracer.py::_VALID_KINDS`, `swarmtrace/scraper.py`, `frontend-next/app/api/mcp/route.ts` (Zod enum), `frontend-next/lib/resolve-trace-identity.ts::TraceKind` | `tests/test_tracer.py::test_invalid_kind_rejected`, `tests/test_tracer.py::test_retrieval_kind_accepted_by_observe`, `tests/test_scraper.py::test_scrape_kind_override_to_retrieval`, `frontend-next/scripts/test-resolve-trace-identity.mjs`, `tests/integration/test_postgres_contract.py::test_phase3_retrieval_kind_round_trips` |
| Stable `agent_id` hash (SDK) | `swarmtrace/tracer.py::_stable_agent_id` | `tests/test_tracer.py` |
| Stable `agent_id` hash (MCP/frontend) | `frontend-next/lib/stable-agent-id.ts::stableAgentId` | `frontend-next/scripts/test-derive-agent-cards.mjs` |
| Grouping traces into agent cards | `frontend-next/lib/derive-agent-cards.ts::deriveAgentCards` | `frontend-next/scripts/test-derive-agent-cards.mjs` |
| `agent_id` / `kind` contract end to end | this doc | `tests/test_tracer.py::test_api_agents_filter_contract` |

## Changing the contract

1. Change `tracer.py` and, if the hash input changes, `stable-agent-id.ts` in the
   same commit.
2. When adding or removing a `kind`, update all four places listed above together.
   `"retrieval"` was once added to three of them but not `_VALID_KINDS`, so
   `@observe(kind="retrieval")` raised `ValueError` while the scraper and MCP route
   accepted it.
3. Update `derive-agent-cards.ts` if the rule for what counts as an agent changes.
4. Update the tests above and this doc.
5. Run `pytest` and `npm test` in `frontend-next/`; each suite says nothing about
   whether the other side still agrees.
