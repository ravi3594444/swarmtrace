# SwarmTrace Architecture

This document is the maintainer-facing map for SwarmTrace. The PRD explains
where the product is going; this document defines the code boundaries that keep
that direction implementable.

## 1. System purpose

SwarmTrace records AI-agent activity as a linked history of spans:

```text
agent run
├── llm call
├── tool call
├── retrieval/network/browser/file event
├── sub-agent run
└── error/output metadata
```

The core promise is intentionally narrow: telemetry must never change the user's
agent behavior. If storage, transport, auto-instrumentation, FOV capture, MCP, or
OTLP fail, the application result and exception semantics remain unchanged.

## 2. Architectural style

SwarmTrace uses a small ports-and-adapters architecture.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Public APIs + ingestion surfaces                                   │
│ observe/init/session | run/span | MCP gateway | OTLP collector      │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────┐
│ Core model + context + runtime                                     │
│ SpanRecord | TraceContext | Runtime | events | ports               │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────┐
│ Adapters / delivery                                                │
│ SQLite repository | HTTP transport | background sender             │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
┌──────────────────────────────▼─────────────────────────────────────┐
│ Local DB + remote dashboard ingest                                 │
│ ~/.swarmtrace.db | /api/ingest | /api/events | Supabase/dashboard   │
└────────────────────────────────────────────────────────────────────┘
```

### Dependency rule

Dependencies flow downward:

```text
public APIs / gateways / optional integrations
    -> core model, context, runtime, ports, config
        -> adapters and delivery
            -> external systems
```

Core modules must not import provider SDKs, agent frameworks, or concrete tool
vendors. Optional integrations may import provider libraries defensively and must
handle `ImportError` as "feature unavailable", not as a process failure.

## 3. Python SDK package map

| Area | Files | Responsibility |
|---|---|---|
| Public façade | `swarmtrace/__init__.py`, `tracer.py`, `run.py` | Stable user APIs: `init`, `observe`, `session`, `run`, `span`. Backward-compatible private aliases live here only when needed. |
| Shared config | `config.py` | Lazy remote API key/endpoint resolution, endpoint safety validation, base-URL normalization. Runtime, FOV, alerts, and tracer all use this instead of importing tracer internals. |
| Core model/context | `span_model.py`, `trace_context.py`, `ports.py` | Canonical span shape, context propagation, repository/transport protocols. No I/O side effects beyond contextvars. |
| Runtime seam | `runtime.py`, `events.py` | One record/resync entrypoint, event bus, runtime injection for tests/custom embeddings. |
| Adapters | `adapters/sqlite_repository.py`, `adapters/http_transport.py` | Concrete persistence and HTTP ingest mapping. |
| Delivery | `delivery/sender.py` | Bounded background queue, batching, retry, fork-safe sender state. |
| Instrumentation | `auto_instrument.py`, `fov.py`, `scraper.py` | Optional capture around LLM SDKs, browser/network/filesystem events, scraping/retrieval. Must degrade safely. |
| Protocol ingress | `mcp_gateway.py`, `gateway_config.py`, `gateway_cli.py`, `otlp.py`, `otlp_mapping.py` | Generic MCP and OTLP paths. No Firecrawl/LangGraph/CrewAI-specific core code. |
| Local analysis | `budget.py`, `alerts.py`, `replay.py`, `export.py`, `regression.py`, `tool_attention.py` | Features that consume recorded spans/events. |
| Persistence | `storage.py` | SQLite schema, migrations, retention, and row-shaped compatibility API. |

## 4. Frontend/dashboard map

| Area | Files | Responsibility |
|---|---|---|
| API ingestion | `frontend-next/app/api/ingest/*`, `frontend-next/lib/validate-ingest.ts`, `decode-body.ts` | Accept SDK/MCP/OTLP trace payloads, validate and redact. |
| Identity contract | `frontend-next/lib/resolve-trace-identity.ts`, `stable-agent-id.ts`, `derive-agent-cards.ts` | Keep `kind` and `agent_id` semantics synchronized with Python. See `docs/SDK_DASHBOARD_CONTRACT.md`. |
| Trace querying | `frontend-next/lib/trace-query.ts`, `trace-types.ts`, `span-tree.ts`, `thread-grouping.ts` | Fetch, type, group, and tree spans for dashboard views. |
| UI shell | `frontend-next/app/*`, `components/dashboard-*`, `components/sidebar.tsx` | Pages, layout, error boundaries, navigation. |
| Trace visualization | `frontend-next/components/swarm/*` | Trace table, call tree, waterfall, detail drawer, JSON views. |

## 5. Canonical data model

Everything recorded by SwarmTrace should be representable as `SpanRecord`:

```python
SpanRecord(
    span_id="...",             # row id / current span id
    parent_span_id="...",      # direct parent, optional
    trace_id="...",            # distributed run id
    name="research-agent",     # function/tool/span display name
    kind="agent",              # agent | llm | tool | retrieval | function
    status="ok",               # ok | error | in_progress (future)
    start_time=..., end_time=...,
    latency_sec=0.123,
    input_tokens=0,
    output_tokens=0,
    cost_usd=0.0,
    agent_id="stable-or-run-id",
    agent_name="Research Agent",
    session_id="thread-42",
    args="redacted/truncated",
    output="redacted/truncated",
    error=None,
    attributes={"provider": "mcp"},
)
```

Important rules:

1. `kind="agent"` spans define agent cards and run boundaries.
2. `llm`, `tool`, `retrieval`, and `function` spans roll up to the nearest
   active agent where context exists.
3. Missing context creates an orphan span. Do not guess a parent.
4. Redaction happens before persistence and before remote transmission.
5. Generic metadata belongs in `attributes`, not provider-specific columns.

## 6. Main data flows

### 6.1 Decorator / custom run flow

```text
user code
  -> @observe or with run()/span()
  -> trace_context sets parent/trace/agent/session contextvars
  -> SpanRecord is created
  -> Runtime.record(span)
  -> repository.save(span) in SQLite
  -> events.emit("span.recorded")
  -> sender.enqueue(payload) if remote config exists
  -> HttpTransport POSTs /api/ingest in batches
```

### 6.2 Auto-instrumented LLM flow

```text
swarmtrace.init(auto_instrument=True)
  -> patch supported SDK methods if installed
  -> wrapper captures model/tokens/cost/latency/error metadata
  -> wrapper reads current TraceContext
  -> Runtime.record(kind="llm")
```

Auto-instrumentation records metadata only; it should not persist prompt or
response content by default.

### 6.3 FOV live-event flow

```text
swarmtrace.init(fov=True)
  -> fov.patch_all()
  -> wrappers emit browser/http/file/stream events when an agent context exists
  -> local agent_events table
  -> /api/events sender if remote config exists
```

FOV events are live activity annotations, not replacements for canonical spans.

### 6.4 MCP gateway flow

```text
agent MCP client
  -> SwarmTrace gateway
  -> upstream MCP tool/server
  -> gateway records one generic tool span per invocation
  -> response/error semantics returned unchanged
```

The gateway observes generic MCP calls. It does not invent an agent root if the
client sends no lifecycle/context information.

### 6.5 OTLP flow

```text
OTel-capable app/framework
  -> OTLP/JSON collector
  -> otlp_mapping.py maps standard span fields to SpanRecord payload shape
  -> existing ingest path
```

### 6.6 Dashboard architecture and network views

The Traces page has an **Architecture** view that turns the current filtered
trace set into product-level architecture layers:

```text
Agents -> LLM -> Tools -> Retrieval -> Functions
```

The dashboard also exposes `/network`, a black desktop **Node Network Map** that
uses `/api/graph` to render individual agent nodes and collaboration edges:

```text
agent node
├── collaborationMode: solo | orchestrator | sub_agent | peer
├── RAG badge from retrieval-like spans
├── heatmap from tokens/cost/errors/retrieval usage
└── connections from parent agent spans and shared trace/session context
```

Both views are computed entirely from canonical fields (`kind`, `agent_id`,
`parent_id`, `trace_id`, `session_id`, tokens, cost, latency, and error state),
so they work for SDK, MCP, and OTLP spans without a provider-specific dashboard
schema.

## 7. Configuration ownership

`swarmtrace.config` owns remote telemetry configuration:

- `SWARMTRACE_API_KEY`
- `SWARMTRACE_ENDPOINT`
- explicit overrides passed through `swarmtrace.init(...)`
- endpoint scheme safety
- `/api` suffix normalization

`tracer.py` still exposes `_remote_config`, `_validate_endpoint_scheme`, and
`_normalize_base_url` as compatibility wrappers, but new code should import from
`swarmtrace.config` directly.

## 8. Extension guidelines

### Adding a new span source

1. Convert the source event into `SpanRecord`.
2. Use `trace_context.current_*` helpers to attach parent/agent/session context.
3. Call `get_runtime().record(span)`.
4. Do not import `storage.py` or `HttpTransport` directly from the new source.
5. Add tests with a fake runtime/repository where possible.

### Adding a new transport or repository

1. Implement the relevant protocol from `ports.py`.
2. Wire it by constructing a `Runtime(repository, transport, config)` and using
   `set_runtime(...)` in tests or embedding code.
3. Keep retries/queueing in delivery-level code, not in business logic.

### Adding a new provider/framework integration

1. Prefer a protocol-level integration (MCP, OTLP, generic `run/span`) over a
   provider-specific module.
2. If a provider-specific patch is necessary, keep it optional and defensive.
3. Never allow integration import/patch failures to affect user code.
4. Never persist provider secrets, request headers, or full prompt/response data
   unless a documented opt-in exists.

### Adding a new dashboard trace field

1. Decide whether it is generic enough for `SpanRecord`/schema or belongs in
   `attributes`.
2. Update SDK storage, ingest validation, Supabase migration, TypeScript trace
   types, and UI rendering together.
3. Update `docs/SDK_DASHBOARD_CONTRACT.md` if the change touches `kind`,
   `agent_id`, or grouping behavior.

## 9. Resilience and privacy invariants

- User exceptions are re-raised exactly as before.
- Telemetry exceptions are caught and logged as warnings/errors.
- Local persistence failures do not crash the observed application.
- Remote delivery uses a bounded queue and must not block user code.
- Unsynced trace rows are preserved for `swarmtrace-resync`.
- API keys are never sent over plaintext HTTP except localhost development.
- Args/output/error fields are redacted and bounded before storage.
- Orphan non-agent spans must not become phantom dashboard agent cards.

## 10. Packaging invariant

The published Python package must include nested architecture packages such as
`swarmtrace.adapters` and `swarmtrace.delivery`. `pyproject.toml` therefore uses
setuptools package discovery with `include = ["swarmtrace*"]`; do not replace it
with a single-package list unless every runtime subpackage is still included.

## 11. Architecture enforcement

`tests/test_architecture_boundaries.py` turns the most important boundaries into
executable checks:

- pure core modules must not import tracer, storage, adapters, delivery, or
  optional instrumentation;
- runtime/FOV/alerts must use `swarmtrace.config` instead of tracer-private
  remote config helpers;
- nested runtime packages must be included by Python package discovery;
- this document must keep the required maintainer sections.

When intentionally changing these boundaries, update the architecture document
and the boundary tests in the same change.

## 12. Current known architectural debt

- `tracer.py` is still larger than ideal because it preserves historical
  decorator behavior, stable agent identity rules, compatibility aliases, and
  sender shims in one file.
- Some optional modules still keep compatibility aliases for tests that patch
  private names. New code should depend on `trace_context.py` and `config.py`.
- The SQLite `storage.py` API remains row-shaped for backward compatibility;
  new code should prefer `SpanRecord` through `SqliteRepository`.

These are intentional migration seams, not new extension points.
