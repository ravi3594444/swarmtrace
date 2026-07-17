# PRD — SwarmTrace Universal Agent History Refactor

**Status:** Draft  
**Date:** 2026-07-14  
**Product:** SwarmTrace  
**Audience:** Product, SDK, dashboard, and infrastructure maintainers

---

## 1. Summary

SwarmTrace should become a simple way to view the **complete history of an AI agent run**:

```text
Agent run
├── LLM calls
├── Tool calls
├── MCP tool calls
├── Sub-agent runs
├── Retrieval/browser/network events
├── Outputs
└── Errors
```

The user experience must be simple:

```text
Install / connect SwarmTrace once
Set SWARMTRACE_API_KEY
Run the agent normally
Open the dashboard to see its history
```

The current SDK is strongest for Python code explicitly wrapped with `@observe`. It also has targeted auto-instrumentation for a fixed set of LLM SDKs and FOV monkeypatches for selected libraries. This is useful, but it is not a universal connection model: it depends on source-code decorators, known provider APIs, and Python-local `contextvars`.

This refactor creates a **generic agent-history platform** based on stable protocols rather than agent-brand-specific code. The core supports:

1. **Generic run/span model** — one representation for agent, LLM, tool, retrieval, and function activity.
2. **Trace-context propagation** — correct parent/child history across async tasks, processes, and gateways.
3. **MCP gateway** — observe any MCP tool without writing Firecrawl-, Hermes-, or vendor-specific code.
4. **OpenTelemetry-compatible ingestion** — connect agents that already export standard spans.
5. **Generic custom-agent API** — one small integration point for custom agents.
6. **Safe fallback** — unknown agents never break; unsupported sources produce less detail, not application failures.

---

## 2. Product problem

### 2.1 Current user problem

Users want an experience similar to adding an MCP tool such as Firecrawl:

```text
Add configuration/API key
Restart the agent
The integration works
```

They do not want to:

- add `@observe` to every function;
- understand provider-specific monkeypatching;
- write a SwarmTrace integration for every tool;
- change their agent logic merely to receive observability;
- lose their agent history when they change framework, tool, or provider.

### 2.2 Current technical problem

The current tracing path is concentrated in `swarmtrace/tracer.py` and relies on module-local implementation details:

- Python `contextvars` track parent, agent, and session only inside one Python process;
- `tracer.py` owns decorator logic, SQLite persistence, HTTP sending, batching, retries, and worker state;
- some tests patch paths such as `swarmtrace.tracer.urlopen` or `swarmtrace.tracer.save_trace`;
- `fov.py`, `scraper.py`, and `tool_attention.py` import private tracer internals;
- auto-instrumentation recognizes only selected SDK methods;
- the current MCP route accepts manually submitted `record_trace` calls but does not automatically observe the agent's internal lifecycle.

This makes refactoring fragile and does not provide a standard way for external agents to connect.

---

## 3. Product vision

> **SwarmTrace is the flight recorder for AI agents. Connect it once and see the complete, linked history of every run.**

The core product promise is deliberately bounded:

> SwarmTrace provides automatic history for agents that use a supported standard connection method: MCP gateway, OpenTelemetry, or the generic SwarmTrace run/span API.

The product must **not** promise perfect semantic history from an arbitrary, unmodified process that provides no lifecycle events, trace context, proxy route, or instrumentation point. That is not technically reliable.

---

## 4. Goals

### 4.1 User goals

1. Set up SwarmTrace through a small number of standard, documented paths.
2. View one ordered history for an agent run, including nested work.
3. See tool calls such as Firecrawl without building a Firecrawl-specific integration.
4. Keep existing agent outputs, errors, streaming behavior, and tool behavior unchanged.
5. Use custom agents with one root integration point rather than many decorators.
6. Keep API keys and sensitive prompt/tool data out of traces by default or through redaction controls.

### 4.2 Engineering goals

1. Separate generic tracing core from I/O adapters and provider integrations.
2. Remove dependence on module-path monkeypatching for core behavior tests.
3. Preserve parent/child relationships across local async execution and supported external boundaries.
4. Reuse the existing `/api/ingest` and dashboard data model where possible.
5. Keep the existing public API working:

   ```python
   from swarmtrace import observe, init, session
   ```

6. Avoid an SDK core that contains per-agent files such as `hermes.py`, `firecrawl.py`, `langgraph.py`, or `crewai.py`.

---

## 5. Non-goals

The first refactor does **not** aim to:

1. Automatically understand every arbitrary programming language or closed-source agent process.
2. Implement Firecrawl, browser automation, database access, or other tools.
3. Store provider API keys in the SwarmTrace dashboard backend.
4. Replace an agent framework's own tool registry or orchestration system.
5. Rewrite all current modules in one change.
6. Add a separate integration file for every AI framework.
7. Change the dashboard's agent identity (`agent_id`/`kind`) contract without an explicit cross-stack migration.

---

## 6. Personas and setup journeys

### 6.1 MCP agent user

The agent supports MCP and uses one or more MCP tools.

Desired setup:

```bash
swarmtrace gateway --config agent-tools.json
```

The local gateway exposes/proxies the user's MCP tools. The agent points to the gateway instead of directly to each upstream tool server.

Result:

```text
Agent → SwarmTrace MCP Gateway → any MCP tool
```

SwarmTrace automatically records generic tool spans, regardless of whether the upstream tool is Firecrawl, GitHub, browser automation, a database, or a custom MCP server.

**Known limit:** an MCP gateway sees tool calls. It cannot infer every internal agent/LLM run boundary unless the agent propagates trace context or also exports lifecycle spans.

### 6.2 OpenTelemetry-capable agent user

The agent/framework already emits OpenTelemetry spans.

Desired setup:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://<collector>/v1/traces"
export SWARMTRACE_API_KEY="..."
```

Result: SwarmTrace translates OTLP spans into the SwarmTrace run history.

### 6.3 Custom-agent user

The user owns their agent code and can add one root integration point.

Desired setup:

```python
from swarmtrace import run

with run("research-agent"):
    agent.run(task)
```

Result: all supported nested instrumentation, MCP gateway calls, and manual child spans attach to one root run.

### 6.4 Existing Python SDK user

The existing code remains valid:

```python
@observe
def my_agent(task):
    ...
```

`@observe` becomes an implementation of the new generic span model, not a separate tracing system.

---

## 7. Core product model

### 7.1 Canonical data model

The internal model is a single `SpanRecord` that represents every lifecycle event. The span carries enough information to reconstruct both the call hierarchy and the dashboard aggregation axes.

```python
@dataclass
class SpanRecord:
    span_id: str              # Primary key; current traces.id
    parent_span_id: Optional[str]  # traces.parent_id
    trace_id: str             # Distributed run id (new column in Phase 5)
    name: str                 # traces.function
    kind: str                 # agent | llm | tool | retrieval | function
    status: str               # ok | error | in_progress
    start_time: datetime
    end_time: Optional[datetime]
    latency_sec: float
    input_tokens: int
    output_tokens: int
    cost_usd: float
    agent_id: Optional[str]
    agent_name: Optional[str]
    session_id: Optional[str]
    args: Optional[str]
    output: Optional[str]
    error: Optional[str]
    attributes: dict          # Generic JSON metadata (new column in Phase 5)
```

A `run` is simply a span whose `kind == "agent"`. A child span is any span with a `parent_span_id` pointing to another span in the same `trace_id`.

### 7.2 Canonical trace context

Every span carries a portable context:

```text
trace_id          Whole distributed agent run
span_id           Current operation
parent_span_id    Direct parent operation, if any
agent_id          Stable dashboard identity
agent_name        Dashboard display name
session_id        Optional multi-turn conversation identity
```

The current `id`/`parent_id` trace table fields can remain the persisted representation for the first phase:

```text
trace_id / span_id        → traces.id
parent_span_id            → traces.parent_id
```

The `trace_id` field is added in Phase 5 and backfilled from `span_id` for existing rows (each existing row becomes its own trace until cross-span context is available).

### 7.3 Context propagation rules

1. Python-local execution uses `contextvars`.
2. Cross-process boundaries use W3C Trace Context (`traceparent`, `tracestate`) where the protocol permits it, or an equivalent documented SwarmTrace context envelope.
3. MCP gateway requests propagate context when the client/upstream supports metadata/context fields.
4. If no context is present, the gateway creates an orphan tool trace rather than inventing an incorrect agent parent.
5. Concurrent children share a parent but each receive distinct span IDs.

### 7.4 Metadata model

Do not add fixed columns for specific tools/providers, such as `firecrawl_url` or `tavily_results`.

The target model includes an optional JSON metadata/attributes field:

```json
{
  "provider": "mcp",
  "tool_name": "scrape",
  "upstream": "example-tool-server",
  "status_code": 200
}
```

This field is optional in the first ingestion-compatible phase and should be introduced through a coordinated schema/API/dashboard migration when the dashboard is ready to display it.

---

## 8. Target architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                         Agent / Application                       │
│   MCP client | OTLP exporter | Python custom code | existing SDK  │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                 ┌──────────────┼──────────────┐
                 │              │              │
                 v              v              v
        ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
        │ MCP Gateway  │ │ OTLP Mapper  │ │ Python Runtime│
        └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
               └──────────────┬─┴───────────────┘
                              v
                   ┌─────────────────────┐
                   │ Canonical Span/Run  │
                   │ + Trace Context     │
                   └──────────┬──────────┘
                              v
              ┌──────────────────────────────────┐
              │ Local repository + remote sender  │
              └───────────────┬──────────────────┘
                              v
                ┌──────────────────────────────┐
                │ Existing /api/ingest endpoint │
                └───────────────┬──────────────┘
                                v
                      ┌──────────────────┐
                      │ Dashboard history │
                      └──────────────────┘
```

### 8.1 Dependency direction

```text
Public APIs / gateways / optional integrations
                    ↓
          Core run/span/context model
                    ↓
          Repository and transport contracts
                    ↓
    SQLite, HTTP, queue, OTLP/MCP implementation adapters
```

No core module may import a specific agent framework, Firecrawl, or other tool vendor.

### 8.2 Ports and adapters (explicit protocols)

Core contracts are defined as Python `typing.Protocol` in `swarmtrace/ports.py`:

```python
class SpanRepository(Protocol):
    def save(self, span: SpanRecord) -> None: ...
    def get_children(self, span_id: str) -> list[SpanRecord]: ...
    def mark_synced(self, span_id: str, synced: int) -> None: ...

class SpanTransport(Protocol):
    def send(self, spans: list[SpanRecord]) -> None: ...
```

Adapters live under `swarmtrace/adapters/` and `swarmtrace/delivery/`.

---

## 9. Functional requirements

### FR-1: Generic run API

Provide a public root-run API:

```python
with swarmtrace.run("agent-name"):
    ...
```

Requirements:

- Generates a root agent span.
- Sets portable trace context for nested work.
- Captures completion, latency, and errors.
- Does not suppress or replace user exceptions.
- Supports sync and async usage.
- Preserves `session_id` when provided.

### FR-2: Generic child span API

Provide an internal/public child span API suitable for SDK adapters and custom users:

```python
with swarmtrace.span("tool-name", kind="tool"):
    ...
```

The API must support both synchronous and asynchronous operations.

### FR-3: MCP gateway

Provide a local generic MCP gateway process.

Requirements:

- Proxies generic MCP tool discovery and invocation.
- Does not contain Firecrawl-specific behavior.
- Records tool name, timing, status, error, parent context when available, and safe metadata.
- Returns upstream responses unchanged.
- Preserves streaming/cancellation semantics where supported by the MCP transport.
- Keeps upstream tool credentials on the local machine/process by default.
- Never logs secrets from gateway configuration or tool arguments.

The gateway is an **optional extra**, not part of the core install:

```toml
[project.optional-dependencies]
gateway = ["mcp", "uvicorn"]
```

### FR-4: OTLP/standard span ingestion

Provide an OTLP-compatible mapping path or an explicitly documented HTTP collector protocol.

Requirements:

- Maps trace ID, span ID, parent span ID, timestamps, status, attributes, and resource names into canonical SwarmTrace spans.
- Uses authenticated ingestion.
- Rejects invalid/oversized payloads.
- Does not require a per-framework adapter.

**Deployment recommendation:** OTLP ingestion runs as a separate lightweight service (e.g., FastAPI/ASGI) that maps spans to the existing `/api/ingest` endpoint. Do not force OTLP/gRPC into Vercel serverless.

### FR-5: Existing SDK compatibility

Requirements:

- `@observe`, `init`, and `session` retain their public behavior.
- Existing SQLite outbox and resync semantics remain intact.
- Existing `agent_id`/`kind` dashboard contract remains intact.
- Existing auto-instrumented provider calls become children of the active generic context.

### FR-6: Safe degradation

Requirements:

- Unsupported agent/tool/provider never crashes the application.
- Missing trace context creates a valid orphan span, not a false hierarchy.
- Integration import errors are isolated and reported through logging only.
- Telemetry failure never changes a tool result or user exception.

### FR-7: Privacy and secrets

Requirements:

- API keys must never be persisted as trace arguments, output, metadata, or error content.
- Redaction is applied before local persistence and remote transmission.
- Tool argument capture is configurable and defaults to safe limits.
- Gateway configuration is local by default; no third-party tool API key is uploaded to SwarmTrace merely to enable tracing.

---

## 10. Implementation plan and file plan

### Phase 0 — Baseline and contracts

**Purpose:** freeze current behavior and define the common model before moving implementation logic.

#### New files

```text
swarmtrace/trace_context.py
swarmtrace/span_model.py
swarmtrace/ports.py
```

#### Modified files

```text
swarmtrace/tracer.py
swarmtrace/__init__.py
tests/test_tracer.py
docs/SDK_DASHBOARD_CONTRACT.md
```

#### Work

- Extract portable `TraceContext` type.
- Define canonical `SpanRecord` model.
- Preserve existing contextvars through compatibility aliases.
- Add regression tests for stable agent IDs, nested spans, sessions, async tasks, and errors.
- Define `SpanRepository` and `SpanTransport` protocols.

#### Exit criteria

- Existing SDK behavior remains unchanged.
- Parent/agent/session state has one documented owner.
- No dashboard contract drift.

---

### Phase 0.5 — Vertical slice: `run()` / `span()` with a real LLM

**Purpose:** prove the new model works end-to-end before extracting all seams.

#### New files

```text
swarmtrace/run.py
examples/run_openai.py
tests/test_run.py
```

#### Modified files

```text
swarmtrace/__init__.py
```

#### Work

- Implement `run()` and `span()` as sync/async context managers.
- Have them use the existing `_safe_flush` / `save_trace` path so they work immediately.
- Test with a real LLM call (`OPENAI_API_KEY`) that the dashboard/SQLite shows a root agent and child LLM span.

#### Exit criteria

```python
with swarmtrace.run("custom-agent"):
    client.chat.completions.create(...)
```

produces a root agent run with a correctly linked LLM child span.

---

### Phase 1 — Core recording and adapter seams

**Purpose:** make tracing independent from direct SQLite/HTTP module globals.

#### New files

```text
swarmtrace/runtime.py
swarmtrace/adapters/sqlite_repository.py
swarmtrace/adapters/http_transport.py
swarmtrace/delivery/sender.py
```

#### Modified files

```text
swarmtrace/tracer.py
swarmtrace/auto_instrument.py
swarmtrace/fov.py
swarmtrace/storage.py
swarmtrace/__init__.py
tests/test_tracer.py
tests/test_auto_instrument.py
tests/test_batching.py
tests/test_resync.py
tests/test_fork_worker.py
```

#### Work

- Implement repository and transport contracts.
- Move HTTP, batching, retry, and worker concerns out of `tracer.py`.
- Route decorator and provider instrumentation through one canonical record path.
- Replace core test monkeypatches with fake repository, fake transport, fake clock/sleep, and isolated sender instances.
- Move FOV imports away from private tracer names to stable context/config APIs.

#### Exit criteria

- `tracer.py` is a public tracing façade rather than a transport/storage worker.
- Unit tests do not patch `swarmtrace.tracer.urlopen`, `save_trace`, `_send_queue`, or worker flags.
- Existing SDK public behavior stays compatible.

---

### Phase 2 — Generic run/span API

**Purpose:** let any custom agent create accurate history with one root integration point.

#### New files

```text
swarmtrace/events.py
```

#### Modified files

```text
swarmtrace/__init__.py
swarmtrace/tracer.py
swarmtrace/cli.py
README.md
tests/test_run.py
```

#### Work

- Add `run()` and `span()` context managers (already prototyped in Phase 0.5).
- Support sync and async contexts.
- Make decorators use the same span implementation.
- Document custom-agent setup without agent-brand-specific APIs.

#### Exit criteria

```python
with swarmtrace.run("custom-agent"):
    agent.run(task)
```

produces a root agent run with correctly linked children.

---

### Phase 3 — Generic MCP gateway

**Purpose:** observe any MCP tool through one local, protocol-level gateway.

#### New files

```text
swarmtrace/mcp_gateway.py
swarmtrace/gateway_config.py
swarmtrace/gateway_cli.py
tests/test_mcp_gateway.py
tests/test_gateway_config.py
```

#### Modified files

```text
pyproject.toml
swarmtrace/cli.py
swarmtrace/__init__.py
README.md
docs/MCP_GATEWAY.md
```

#### Work

- Add optional `gateway` dependency group and gateway console command.
- Implement generic MCP tool-list and tool-call proxying using the official `mcp` Python SDK.
- Record generic tool spans without provider-specific code.
- Propagate W3C/SwarmTrace trace context when supported.
- Keep upstream MCP credentials local.
- Document configuration examples generically, not for named vendors.

#### Explicit limitation

The gateway can guarantee MCP tool history. It cannot independently infer arbitrary agent root runs and LLM calls when the client sends no lifecycle/context information.

#### Exit criteria

- A generic fake MCP tool server can be proxied.
- Tool result/error/streaming behavior remains unchanged.
- A tool span is emitted exactly once per invocation.
- Parent context links correctly when sent by the caller.

---

### Phase 4 — OpenTelemetry/remote collector path

**Purpose:** receive full histories from standard OTel-capable agents without per-framework code.

#### New files

```text
swarmtrace/otlp.py
swarmtrace/otlp_mapping.py
tests/test_otlp_mapping.py
```

#### Possible backend files

```text
# Separate lightweight collector service (recommended)
swarmtrace/otlp_collector.py

# Alternative: extend the Next.js ingest route only for HTTP/JSON OTLP
frontend-next/app/api/otlp/route.ts
```

#### Modified files

```text
frontend-next/app/api/ingest/route.ts
frontend-next/lib/validate-ingest.ts
README.md
docs/OTEL.md
```

#### Work

- Choose and document supported OTLP transport(s): HTTP/protobuf or HTTP/JSON via a separate collector service.
- Authenticate trace export with SwarmTrace API keys.
- Map OTel span context/status/attributes to the canonical model.
- Apply payload size, rate limit, and redaction rules.

#### Exit criteria

- Generic OTel test spans appear as correct parent/child dashboard traces.
- No agent-specific source code is required.

---

### Phase 5 — Generic metadata and dashboard history UX

**Purpose:** display useful generic tool/LLM information without vendor-specific schema fields.

#### New files

```text
supabase/migrations/<new>_trace_metadata.sql
```

#### Modified files

```text
swarmtrace/storage.py
swarmtrace/span_model.py
frontend-next/app/api/ingest/route.ts
frontend-next/lib/validate-ingest.ts
frontend-next/lib/trace-query.ts
frontend-next/app/<trace-detail UI files>
frontend-next/app/api/mcp/route.ts
tests/test_storage.py
tests/integration/test_postgres_contract.py
```

#### Work

- Add optional JSON metadata/attributes column with a coordinated migration.
- Validate and size-limit attributes.
- Render a chronological run timeline and nested tree in the dashboard.
- Preserve safe/redacted views of tool input/output.

#### Migration SQL

```sql
ALTER TABLE traces
ADD COLUMN IF NOT EXISTS trace_id TEXT,
ADD COLUMN IF NOT EXISTS attributes JSONB DEFAULT NULL;

-- Backfill: existing rows are their own trace until cross-span context is available.
UPDATE traces SET trace_id = id WHERE trace_id IS NULL;
```

#### Exit criteria

- Tool and OTel attributes display generically.
- No provider-specific database columns are introduced.

---

## 11. Current files and migration boundaries

### Current modules that must stop importing tracer internals

| Current module | Current dependency | Target dependency |
|---|---|---|
| `swarmtrace/fov.py` | `_current_agent`, `_remote_config`, `_normalize_base_url` from `tracer.py` | stable `trace_context.py` and `config.py` APIs |
| `swarmtrace/scraper.py` | `_parent_ctx`, `_current_parent`, `_current_agent` from `tracer.py` | stable context API |
| `swarmtrace/tool_attention.py` | `_current_agent` from `tracer.py` | stable context API |
| `swarmtrace/auto_instrument.py` | private tracing/storage helpers | canonical runtime/span emitter |
| `swarmtrace/alerts.py` | lazy private remote config import | stable config API |
| `swarmtrace/cli.py` | direct `tracer.resync` import | public resync service API |

### Existing dashboard/API contracts that must remain synchronized

The following already share `kind` and `agent_id` rules and must be changed together if the contract changes:

```text
swarmtrace/tracer.py
swarmtrace/scraper.py
frontend-next/app/api/mcp/route.ts
frontend-next/lib/resolve-trace-identity.ts
frontend-next/lib/stable-agent-id.ts
frontend-next/lib/derive-agent-cards.ts
docs/SDK_DASHBOARD_CONTRACT.md
```

No refactor may silently change this behavior.

---

## 12. Public API compatibility contract

The following public API remains stable for at least one major version:

```python
from swarmtrace import observe, init, session
from swarmtrace import get_traces, save_trace
from swarmtrace import budget, reset_budget, get_usage
from swarmtrace import show_failures, ToolAttention, set_model_pricing, patch_all, get_events, fov, alerts
from swarmtrace.regression import compare
from swarmtrace.scraper import scrape
```

New APIs are added alongside, not replacing:

```python
from swarmtrace import run, span
```

Internal symbols (`_current_agent`, `_parent_ctx`, etc.) are not public API. During Phase 0 they remain as compatibility aliases in `tracer.py` for existing optional modules, but external code should not depend on them.

---

## 13. Acceptance criteria

### Core compatibility

- [ ] All existing public Python imports continue to work.
- [ ] `@observe` continues to trace sync and async functions.
- [ ] Existing SQLite resync/outbox behavior remains functional.
- [ ] Existing agent identity and dashboard grouping tests pass.
- [ ] A real LLM call under `run()` produces a linked agent + LLM history.

### Generic custom agent

- [ ] One `run()` call creates one root run.
- [ ] Nested `span()` calls become correct children.
- [ ] Parallel async children share a parent and have different IDs.
- [ ] Exceptions remain visible to the caller and also appear in history.

### MCP gateway

- [ ] Gateway works with a generic test MCP upstream, not a vendor-specific server.
- [ ] One MCP tool invocation creates one tool span.
- [ ] The upstream response is byte/semantic equivalent to direct use.
- [ ] Upstream failures return normally and create failed spans.
- [ ] No upstream API key appears in logs or trace payloads.
- [ ] Incoming parent trace context is preserved.

### OTLP path

- [ ] Standard trace/span/parent context maps correctly.
- [ ] OTel status/error maps correctly.
- [ ] Unsupported attributes are safely bounded/redacted.
- [ ] Invalid payloads are rejected without affecting other ingestion.

### Dashboard

- [ ] A root agent run displays a nested history tree.
- [ ] Tool, LLM, retrieval, and sub-agent spans display under their parent.
- [ ] Orphan spans do not become phantom agent cards.
- [ ] Metadata is generic and does not assume a provider name.

---

## 14. Risks and mitigations

| Risk | Reality | Mitigation |
|---|---|---|
| Claiming universal automatic history | Impossible for arbitrary processes that expose no events/context | Clearly document supported connection methods and safe fallback behavior |
| Incorrect parent/child relationships | Worse than missing data; dashboard history becomes misleading | Use standard trace context; create orphans when parent is unknown rather than guessing |
| MCP proxy breaks streaming/cancellation | Proxying protocol semantics is non-trivial | Build generic contract tests for normal call, failure, cancellation, and streaming before release |
| Vercel cannot host every OTLP transport | OTLP/gRPC may require long-running/streaming infrastructure | Use a separate collector service; start with HTTP mapping |
| Secrets captured in tool inputs/errors | Tool/API keys may be embedded in arguments/URLs | Redact before persistence, cap fields, keep gateway credentials local |
| Huge refactor breaks existing SDK | `tracer.py` currently has many responsibilities and dependants | Use phased extraction plus compatibility aliases; run full Python and frontend suites every phase |
| Framework-specific pressure returns | Users may request named integrations | Keep named integrations outside the core; prioritize MCP/OTel/generic APIs |
| Phase 1 test seam refactor is large | 80+ tests depend on `tracer.py` internals | Do Phase 0.5 first to validate the model; then rewrite tests with fake repository/transport |

---

## 15. Delivery order and estimate

These are engineering estimates for one developer working full time. They are not guarantees; the MCP/OTLP transport details and test environment can change the range.

| Milestone | Estimate | User value |
|---|---:|---|
| Phase 0: contracts/context baseline | 1–3 working days | safer refactor starting point |
| Phase 0.5: vertical slice with real LLM | 2–3 working days | proves the new model end-to-end |
| Phase 1: core runtime/adapters/test seams | 5–10 working days | less fragile SDK and tests |
| Phase 2: generic `run()`/`span()` API | 3–5 working days | custom agent full history with one integration point |
| Phase 3: generic MCP gateway | 5–10 working days | tool history for any MCP tool/server |
| Phase 4: OTLP collector/mapping | 7–15 working days | standard path for full histories without framework adapters |
| Phase 5: generic metadata/dashboard history UX | 5–10 working days | richer, readable complete run timeline |

### Recommended first releasable scope

Release after Phases 0, 0.5, and 3:

```text
- Existing SDK remains compatible
- Custom agents use one generic run() call
- Any MCP tool can be observed through one generic gateway
- Dashboard shows linked agent/tool history where trace context exists
```

This is realistic and useful without making false claims about every arbitrary agent process.

---

## 16. Decisions required before implementation

1. **OTLP deployment:** use a separate collector service or support only HTTP-based ingestion initially?  
   **Recommended:** separate collector service.
2. **MCP gateway runtime:** local CLI sidecar only in v1, or also a hosted gateway?  
   **Recommended:** local CLI sidecar only in v1.
3. **Trace context format:** W3C `traceparent` as the primary external format, with a documented SwarmTrace envelope only where required?  
   **Recommended:** W3C `traceparent` primary; SwarmTrace envelope only where needed.
4. **Privacy defaults:** capture redacted tool names/latency only by default, or capture truncated redacted arguments/output by default?  
   **Recommended:** capture truncated/redacted arguments/output by default, with opt-in full capture.
5. **Metadata migration:** ship generic JSON attributes in the first gateway release or defer until dashboard UI is ready?  
   **Recommended:** add the column in Phase 0/1 so the gateway can store attributes; defer UI rendering to Phase 5.
6. **Custom agent API:** settle on `run()`/`span()` names before public release.  
   **Recommended:** `run()` for root agent runs, `span()` for all child spans.

---

## 17. Addressing existing higher-level features

### `swarmtrace.regression.compare()`

`regression.py` is a higher-level prompt-regression testing API that uses an LLM to score output similarity. It is **not** part of the generic tracing core. It remains a public API under `from swarmtrace.regression import compare` and the `[regression]` optional dependency. Future work may expose it via a dashboard API route, but the refactor does not remove or merge it into the tracing core.

### `swarmtrace.scraper.scrape()` and `ToolAttention`

These are existing optional public API features. The refactor does not delete them. It only removes their direct imports of private `tracer.py` internals by routing them through the stable `trace_context.py` API.

### `budget.py`, `pricing.py`, `alerts.py`

- `pricing.py` computes cost from model/token information and attaches it to LLM spans.
- `budget.py` consumes the repository to sum per-agent token usage and enforce limits.
- `alerts.py` consumes the repository to evaluate rule conditions.

None of them should import `tracer.py` internals. They depend on the repository contract and the span model.

---

## 18. Definition of done

This refactor is complete when:

1. SwarmTrace has one generic run/span/context model used by decorators, auto-instrumentation, MCP gateway, and OTLP mapping.
2. The SDK core has no agent-brand- or tool-brand-specific dependencies.
3. A generic MCP tool server can be used through SwarmTrace gateway and produces linked tool history.
4. A custom agent can produce a complete hierarchy with one root `run()` integration point.
5. An OTel-capable agent can send standard spans without a framework-specific SwarmTrace adapter.
6. Existing SDK users remain compatible.
7. Telemetry failures and unsupported integrations never break an agent.
8. The dashboard displays a readable linked history rather than isolated trace rows.
9. A real LLM call under `run()` has been manually verified to produce correct parent/child history.
