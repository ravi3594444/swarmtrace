# SDK ↔ Dashboard contract: `agent_id` and `kind`

Audit finding #1. This is the single source of truth for how the Python
SDK, the MCP route, and the Next.js dashboard agree on what counts as
"one agent" and "one run." Before this doc, the rules lived only as
scattered comments in three different files (`tracer.py`,
`derive-agent-cards.ts`, `stable-agent-id.ts`) with nothing tying them
together — this is what changes when any of those files change.

**If you're changing any of the files listed under "Where each rule
lives" below, read this doc first and update it in the same PR/commit.**

## The contract, in one paragraph

A `trace` row becomes part of an "agent card" on the dashboard iff its
`agent_id` matches at least one other row with `kind == "agent"` in the
same group. `agent_id` is either a random per-call id (swarm sub-agents)
or a **stable** SHA-256 hash of the agent's identity (bare `@observe`
entrypoints and MCP calls), so that repeat runs of the same logical
agent collapse into one card instead of spawning a new card per run.

## `kind` — how a trace gets classified

Six values: `"agent"`, `"tool"`, `"llm"`, `"function"`, `"retrieval"`,
and the SDK-only input value `"auto"` (never stored — always resolved
before save). Resolution logic (`tracer.py::_resolve_kind`):

```
resolved_kind = kind if kind != "auto" else (
    "agent" if there is no enclosing agent span else "function"
)
```

In plain terms: a bare `@observe` call becomes `kind="agent"` only when
nothing else is already tracking it as a sub-call; if it's nested inside
another traced call, it becomes `kind="function"` instead. Explicit
`@observe(kind="agent")`, `@observe(kind="tool")`, `@observe(kind="retrieval")`,
etc. always keep the kind you asked for, no resolution needed.

`"retrieval"` was added in the Phase 3 RAG effort for document-loading /
vector-search spans (qdrant/pinecone/chroma lookups, `scraper.scrape(kind="retrieval")`
for RAG ingestion, etc.). It is a leaf kind like `"tool"`/`"llm"`/`"function"`
— never auto-resolved to, never becomes its own agent card, and must
have an `agent_id` when recorded through the stateless MCP route (see
`lib/resolve-trace-identity.ts`). The same kind set must be accepted by
all four entry points: the Python `@observe` decorator (`tracer.py::_VALID_KINDS`),
`scraper.scrape(kind=...)`, the MCP `record_trace` Zod enum
(`app/api/mcp/route.ts`), and the dashboard's `TraceKind` union
(`lib/resolve-trace-identity.ts`). Drift between any of them is the
failure mode this section exists to prevent.

**Anti-phantom guarantee:** an orphan `tool`/`llm`/`function`/`retrieval`
call with no enclosing agent still gets `kind != "agent"` — the SDK only
assigns `kind="agent"` to the auto-resolved top-level span itself, never
to tool/llm/function/retrieval spans underneath it. This is why
`deriveAgentCards` can safely gate on "has at least one `kind=='agent'`
row" without separately checking for orphans.

## `agent_id` — how runs get grouped into one card

Two schemes, both computed in `tracer.py`:

| Case | `agent_id` | Why |
|---|---|---|
| Bare `@observe` (auto-resolved to `kind="agent"`) | `sha256(f"{module}.{qualname}")` or `sha256(name)` if `name=` was passed — **64 hex chars**, deterministic | Every run of the *same* top-level function collapses into one dashboard card whose task count climbs over time, instead of one card per run |
| Explicit `@observe(kind="agent")` | fresh `trace_id` (random) per call | Swarm sub-agents (orchestrator/researcher/summarizer within one parent run) must stay **distinct** cards, not merge into one |
| MCP `record_trace` tool, no explicit `agent_id` | `sha256(function_name)` via `stable-agent-id.ts` — **same algorithm as the SDK**, called from the frontend since MCP traces don't originate from `tracer.py` | MCP calls aggregate the same way SDK calls do |

`stable-agent-id.ts::stableAgentId` is a direct TypeScript port of
`tracer.py::_stable_agent_id`'s hashing (SHA-256 hex digest of the
identity string) — they must produce byte-identical output for the same
input, or MCP-vs-SDK traces for "the same" logical agent will show up as
two separate cards. There's no automated cross-language hash-equality
test today (Python `hashlib.sha256` vs Node `crypto.createHash('sha256')`
are both standard SHA-256, so divergence risk is low, but if either side
ever changes the *input string* it hashes — not just the algorithm —the
two sides will silently stop matching). If you touch the hash input
construction on either side, update both.

Known limitation (documented in `tracer.py::_stable_agent_id`, not a
bug): two lambdas defined on the exact same source line collide. Two
closures from the same factory function collide unless you pass
`name=`. Both are edge cases users can work around with an explicit
`name=`.

### `DO NOT` re-add `t.id === agent_id`

`derive-agent-cards.ts` has an explicit comment against re-adding a
`t.id === agent_id` filter when grouping. That check was only ever
correct under the *old* invariant (`agent_id` was always equal to the
originating trace's own `id`, before stable ids existed). Under the
stable-id scheme, `agent_id` is a hash shared across many distinct
`trace_id`s — re-adding that check would silently drop every bare
`@observe` agent's runs except the one whose random `trace_id` happens
to match the hash (i.e., none of them). This is locked by
`tests/test_tracer.py::test_api_agents_filter_contract` and by the
`REGRESSION GUARD` test in `scripts/test-derive-agent-cards.mjs`.

## "Latest" event/run selection is now sort-order-independent

As of the fix for audit finding #10, `deriveAgentCards` sorts each
group by `timestamp` descending internally before picking the "latest"
run/event — it no longer trusts the caller to have pre-sorted `rows`.
The current caller (`app/api/agents/route.ts` via
`lib/trace-query.ts`'s `order=timestamp.desc`) still sorts at the query
level too (for pagination/limit correctness, not just display), but
`deriveAgentCards` itself is now correct regardless of input order. See
the `SORT GUARD` tests in `scripts/test-derive-agent-cards.mjs`.

## Where each rule lives

| Rule | Source of truth | Tests |
|---|---|---|
| `kind` resolution (`auto` → `agent`/`function`) | `swarmtrace/tracer.py::_resolve_kind` | `tests/test_tracer.py` |
| The accepted `kind` set (`agent`/`tool`/`llm`/`function`/`retrieval` + SDK-only `auto`) must be identical across `@observe`, `scraper.scrape`, MCP `record_trace`, and the dashboard's `TraceKind` union | `swarmtrace/tracer.py::_VALID_KINDS`, `swarmtrace/scraper.py`, `frontend-next/app/api/mcp/route.ts` (Zod enum), `frontend-next/lib/resolve-trace-identity.ts::TraceKind` | `tests/test_tracer.py::test_invalid_kind_rejected`, `tests/test_tracer.py::test_retrieval_kind_accepted_by_observe`, `tests/test_scraper.py::test_scrape_kind_override_to_retrieval`, `frontend-next/scripts/test-resolve-trace-identity.mjs`, `tests/integration/test_postgres_contract.py::test_phase3_retrieval_kind_round_trips` |
| Stable `agent_id` hashing (SDK side) | `swarmtrace/tracer.py::_stable_agent_id` | `tests/test_tracer.py` |
| Stable `agent_id` hashing (MCP/frontend side) | `frontend-next/lib/stable-agent-id.ts::stableAgentId` | `frontend-next/scripts/test-derive-agent-cards.mjs` |
| Grouping traces into agent cards | `frontend-next/lib/derive-agent-cards.ts::deriveAgentCards` | `frontend-next/scripts/test-derive-agent-cards.mjs` |
| The `agent_id ↔ kind` cross-language contract end-to-end | — (this doc) | `tests/test_tracer.py::test_api_agents_filter_contract` |

## Changing this contract

If you need to change any of the above (e.g., a new `kind`, a different
hash input, a new grouping rule):

1. Update `tracer.py` (and `stable-agent-id.ts` if the hash input
   construction changes) together, in the same commit — not staggered
   across sessions. A hash-input change on only one side is the failure
   mode this doc exists to prevent.
2. **When adding or removing a `kind`:** update all four entry points in
   the same commit — `tracer.py::_VALID_KINDS` (the `@observe` decorator),
   `scraper.scrape`'s docstring/defaults, the MCP `record_trace` Zod enum
   in `app/api/mcp/route.ts`, and the `TraceKind` union in
   `lib/resolve-trace-identity.ts`. The Phase 3 RAG effort added
   `"retrieval"` to three of the four but missed `_VALID_KINDS`, which
   left `@observe(kind="retrieval")` raising `ValueError` while
   `scraper.scrape(kind="retrieval")` and the MCP route silently accepted
   it — same taxonomy, three different rules. Don't repeat that.
3. Update `derive-agent-cards.ts`'s grouping logic if the "what counts
   as an agent" rule itself changes (not just the id scheme).
4. Update the tests in the table above, and this doc, in the same
   commit.
5. Run both suites (`pytest` and `npm test` in `frontend-next/`) before
   pushing — a passing Python suite says nothing about whether the
   TypeScript side still agrees with it, and vice versa.
