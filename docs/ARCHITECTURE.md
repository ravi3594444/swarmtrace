# SwarmTrace Architecture

A map of the SwarmTrace code for maintainers: what lives where and which
boundaries to keep.

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

Telemetry must never change the user's agent behavior. If storage, transport,
auto-instrumentation, FOV capture, MCP or OTLP fail, the application's result and
exceptions stay the same.

## 2. Architectural style

The SDK is a small ports-and-adapters design.

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

Core modules must not import provider SDKs, agent frameworks or tool vendors.
Optional integrations import provider libraries defensively and treat
`ImportError` as "feature unavailable".

## 3. Python SDK package map

| Area | Files | Responsibility |
|---|---|---|
| Public API | `swarmtrace/__init__.py`, `tracer.py`, `run.py` | `init`, `observe`, `session`, `run`, `span`, plus a few backward-compatible private aliases. |
| Config | `config.py` | API key and endpoint resolution, endpoint scheme check, base-URL normalization. Runtime, FOV, alerts and tracer use this instead of tracer internals. |
| Core model | `span_model.py`, `trace_context.py`, `ports.py` | Span shape, context propagation, repository and transport protocols. |
| Runtime | `runtime.py`, `events.py` | Single record/resync entry point, event bus, runtime injection for tests. |
| Adapters | `adapters/sqlite_repository.py`, `adapters/http_transport.py` | SQLite persistence and the HTTP ingest mapping. |
| Delivery | `delivery/sender.py` | Bounded background queue, batching, retry, fork-safe state. |
| Instrumentation | `auto_instrument.py`, `fov.py`, `scraper.py` | Optional capture around LLM SDKs, browser/network/file events and scraping. Must fail safely. |
| Protocol ingress | `mcp_gateway.py`, `gateway_config.py`, `gateway_cli.py`, `otlp.py`, `otlp_mapping.py` | Generic MCP and OTLP paths. |
| Local analysis | `budget.py`, `alerts.py`, `replay.py`, `export.py`, `regression.py`, `tool_attention.py` | Consume recorded spans and events. `regression.py` can also report runs to `POST /api/regression` (`report_to_dashboard=True`). |
| Persistence | `storage.py` | SQLite schema, migrations, retention, and the row-shaped compatibility API. |

## 4. Frontend/dashboard map

| Area | Files | Responsibility |
|---|---|---|
| API ingestion | `frontend-next/app/api/ingest/*`, `lib/validate-ingest.ts`, `decode-body.ts` | Accept, validate and redact SDK, MCP and OTLP payloads. |
| Identity | `frontend-next/lib/resolve-trace-identity.ts`, `stable-agent-id.ts`, `derive-agent-cards.ts` | Keep `kind` and `agent_id` in step with the Python SDK. See `docs/SDK_DASHBOARD_CONTRACT.md`. |
| Trace querying | `frontend-next/lib/trace-query.ts`, `trace-types.ts`, `span-tree.ts`, `thread-grouping.ts` | Fetch, type and group spans. |
| UI shell | `frontend-next/app/*`, `components/dashboard-*`, `components/sidebar.tsx` | Pages, layout, navigation. |
| Regression | `frontend-next/app/api/regression/*`, `lib/validate-regression.ts`, `app/regression/*`, `supabase/migrations/0011_regression_runs.sql` | API-key POST (tenant set by `insert_regression_run_for_key`), Clerk/RLS GET, Regression page. |
| Trace views | `frontend-next/components/swarm/*` | Trace table, call tree, waterfall, detail drawer. |

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

Rules:

1. `kind="agent"` spans define agent cards and run boundaries.
2. `llm`, `tool`, `retrieval` and `function` spans roll up to the nearest active
   agent when there is context.
3. Without context a span is an orphan; don't guess a parent.
4. Redact before persisting and before sending.
5. Generic metadata goes in `attributes`, not provider-specific columns.

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

Auto-instrumentation records metadata only and does not store prompt or response
content by default.

### 6.3 FOV live-event flow

```text
swarmtrace.init(fov=True)
  -> fov.patch_all()
  -> wrappers emit browser/http/file/stream events when an agent context exists
  -> local agent_events table
  -> /api/events sender if remote config exists
```

FOV events are live activity annotations and do not replace spans.

### 6.4 MCP gateway flow

```text
agent MCP client
  -> SwarmTrace gateway
  -> upstream MCP tool/server
  -> gateway records one generic tool span per invocation
  -> response/error semantics returned unchanged
```

The gateway records generic MCP calls. It does not invent an agent root when the
client sends no context.

### 6.5 OTLP flow

```text
OTel-capable app/framework
  -> OTLP/JSON collector
  -> otlp_mapping.py maps standard span fields to SpanRecord payload shape
  -> existing ingest path
```

### 6.6 Dashboard architecture and network views

The Traces page has an Architecture view that groups the filtered traces into
layers:

```text
Agents -> LLM -> Tools -> Retrieval -> Functions
```

`/network` is a desktop Node Network Map that uses `/api/graph` to draw agent
nodes and collaboration edges:

```text
agent node
├── collaborationMode: solo | orchestrator | sub_agent | peer
├── RAG badge from retrieval-like spans
├── heatmap from tokens/cost/errors/retrieval usage
└── connections from parent agent spans and shared trace/session context
```

Both views use only the canonical fields (`kind`, `agent_id`, `parent_id`,
`trace_id`, `session_id`, tokens, cost, latency, error state), so they work for
SDK, MCP and OTLP spans alike.

## 7. Configuration ownership

`swarmtrace.config` owns remote configuration: `SWARMTRACE_API_KEY`,
`SWARMTRACE_ENDPOINT`, overrides passed to `swarmtrace.init(...)`, the endpoint
scheme check and `/api` suffix normalization.

`tracer.py` still exposes `_remote_config`, `_validate_endpoint_scheme` and
`_normalize_base_url` as compatibility wrappers. New code should import from
`swarmtrace.config`.

## 8. Extension guidelines

### Adding a new span source

1. Convert the source event into `SpanRecord`.
2. Use `trace_context.current_*` helpers to attach parent/agent/session context.
3. Call `get_runtime().record(span)`.
4. Do not import `storage.py` or `HttpTransport` directly from the new source.
5. Add tests with a fake runtime/repository where possible.

### Adding a new transport or repository

1. Implement the relevant protocol from `ports.py`.
2. Build a `Runtime(repository, transport, config)` and use `set_runtime(...)` in
   tests or embedding code.
3. Keep retries and queueing in the delivery layer.

### Adding a new provider/framework integration

1. Prefer MCP, OTLP or generic `run/span` over a provider-specific module.
2. If a provider patch is needed, keep it optional and defensive.
3. Import or patch failures must not affect user code.
4. Don't persist provider secrets, request headers or full prompts/responses
   unless there is a documented opt-in.

### Adding a new dashboard trace field

1. Decide whether it belongs in `SpanRecord`/the schema or in `attributes`.
2. Update SDK storage, ingest validation, the Supabase migration, TypeScript
   types and UI together.
3. Update `docs/SDK_DASHBOARD_CONTRACT.md` if it touches `kind`, `agent_id` or
   grouping.

## 9. Resilience and privacy invariants

- User exceptions are re-raised unchanged.
- Telemetry exceptions are caught and logged.
- Local persistence failures don't crash the application.
- Remote delivery uses a bounded queue and never blocks user code.
- Unsynced rows are kept for `swarmtrace-resync`.
- API keys are not sent over plain HTTP except to localhost.
- Args, output and error fields are redacted and bounded before storage.
- Orphan non-agent spans must not become dashboard agent cards.

## 10. Packaging invariant

The wheel must include `swarmtrace.adapters` and `swarmtrace.delivery`, so
`pyproject.toml` uses setuptools discovery with `include = ["swarmtrace*"]`. Don't
replace it with a single-package list unless every subpackage is still included.

## 11. Architecture enforcement

`tests/test_architecture_boundaries.py` checks that:

- core modules don't import tracer, storage, adapters, delivery or optional
  instrumentation;
- runtime, FOV and alerts use `swarmtrace.config` rather than tracer-private
  helpers;
- nested packages are included by package discovery;
- this document keeps its required sections.

If you change these boundaries on purpose, update this document and the tests
together.

## 12. Current known architectural debt

- `tracer.py` is larger than it should be: it holds the decorator behavior,
  stable agent identity rules, compatibility aliases and sender shims.
- Some optional modules keep compatibility aliases for tests that patch private
  names. New code should use `trace_context.py` and `config.py`.
- `storage.py` is still row-shaped for backward compatibility; new code should use
  `SpanRecord` through `SqliteRepository`.
