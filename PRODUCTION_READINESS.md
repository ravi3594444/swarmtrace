# SwarmTrace Production Readiness Report

## Performance
- Decorator overhead: ~0.2ms.
- Background sender ensures no blocking of main thread.

## Resilience
- System handles downstream failures (DB/Pricing) gracefully.
- MCP gateway uses per-call upstream stdio connections and closes them cleanly on stop.
- OTLP collector validates, redacts, and forwards batches without blocking the client.

## Recently completed (PRD phases 2–5)
- [x] Generic `run()` / `span()` APIs and span lifecycle events.
- [x] Generic MCP gateway with tool proxying, trace context propagation, and `swarmtrace-gateway` CLI.
- [x] OTLP/JSON mapping and collector (`swarmtrace-otlp`).
- [x] Trace metadata (`trace_id`, `attributes`) propagated through SDK, ingest, MCP, and dashboard.

## Recommendations
- [ ] Implement Clerk-Supabase RLS.
- [ ] Configure Upstash Redis.
- [x] Add pricing fallback.
- [x] Implement trace retention policy.
  - `SWARMTRACE_RETENTION_DAYS` (default 30) purges synced rows older than N days.
  - `SWARMTRACE_MAX_ROWS` (default 10,000) bounds total row count.
  - Unsynced rows are always preserved so the resync CLI can replay them.
