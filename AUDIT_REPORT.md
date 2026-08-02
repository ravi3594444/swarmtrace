# SwarmTrace Security & Architecture Audit

## Pass 2 — 2026-08-02 (post-regression-route re-scan)

### Follow-up — external review findings (same day)

An independent review pass (fresh clone, full toolchain run) surfaced two
frontend issues beyond the pass-2 findings above. Both fixed:

| # | Sev | Finding | Status |
|---|---|---|---|
| F4 | P2 | **`NodeNetworkMap.tsx` auto-select effect caused cascading re-renders.** An effect called `setSelectedId(nodes[0].id)` synchronously once the async layout resolved — flagged as an *error* by the React Compiler lint rule (`react-hooks/set-state-in-effect`). The effect was redundant: `selected` is already derived as `nodes.find(...) ?? nodes[0]`, so the fallback auto-selects the first node while an explicit user selection always wins. | **Fixed** — effect removed; behavior preserved (verified: `selectedId` is only consumed by the derived `selected`). |
| F5 | P3 | **Two `aria-selected` attributes on `role="button"` elements** (`app/traces/page.tsx` trace tree rows, `components/swarm/TraceTable.tsx` table rows) — `aria-selected` is not supported by the `button` role (`jsx-a11y/role-supports-aria-props`). | **Fixed** — replaced with `aria-pressed`, the valid state attribute for toggle buttons. |

Re-validation after fixes: eslint 0 errors (1 benign TanStack Virtual
informational warning), `tsc --noEmit` clean, 249/249 frontend unit tests,
production `next build` green.

### Findings (original pass-2 scan)

Re-audited after the original P0–P3 findings closed and the UI/route surface
grew (regression reporting, MCP `record_trace` kind/identity work, new read
routes). Scope: all 14 API routes, migrations/RLS, SDK collectors, XSS/secret
surface, security headers.

### Findings

| # | Sev | Finding | Status |
|---|---|---|---|
| F1 | **P1** | **MCP `record_trace` persisted unredacted free text and unbounded attributes.** `/api/ingest` and `/api/events` redact `args`/`output`/`error` at the boundary and cap `attributes` at 64 KB JSON — the MCP route (whose whole purpose is non-SDK clients like Hermes/Claude Desktop/Cursor, where the Python SDK's client-side redaction never runs) passed all four straight into `upsert_trace_for_key`. API keys embedded in MCP tool-call arguments landed unredacted in the DB. | **Fixed** — new `lib/sanitize-mcp-trace.ts` truncates to 32 000 chars then PII-redacts text fields, validates `attributes` (plain object, ≤ 64 KB JSON), and rejects invalid attributes with `isError`. 9 unit tests in `scripts/test-mcp-sanitize.mjs`. |
| F2 | P2 | **Clerk read routes returned 500 (not 401) when RLS enforcement failed.** `supaUserRequest` throws `RlsEnforcementError` fail-closed in production; settings POST/DELETE routes converted it to 401, but `agents`, `traces`, `graph`, `metrics`, `overview`, `billing`, and `api-keys` GET all caught generically → 500. Fail-closed either way (no leak), but wrong semantics, noisy logs, and misleading client errors. | **Fixed** — `instanceof RlsEnforcementError → 401` added to all seven. |
| F3 | P3 | **CHANGELOG `[0.6.6]` dated 2026-03-24** though the entry shipped 2026-08-02 — broke the file's newest-first date ordering. | **Fixed** — corrected to 2026-08-02. |

### Re-checked, no new gaps

- **Auth/rate limits:** all 14 routes authenticated (Clerk JWT or `X-API-Key`);
  every route rate-limited (per-user, per-key, and per-IP on the write paths).
- **Tenant isolation:** `traces`, `api_keys`, `daily_metrics`, `agent_events`,
  `user_integrations`, `regression_runs` all have RLS + owner-only policies
  (0001/0002/0004/0005/0006/0011). Write paths use key-bound SECURITY DEFINER
  RPCs (`*_for_key`); dashboard writes go through `supaUserRequest` with
  `WITH CHECK` on user_id.
- **API-key lifecycle:** keys stored as SHA-256 hash + prefix only, returned
  once, plan-limited (402), ownership-checked revoke, no in-process cache
  (revocation is immediate across isolates).
- **Redaction:** ingest + events boundaries redact; SDK redacts client-side
  (`redact.py`); MCP now too (F1).
- **XSS:** no `dangerouslySetInnerHTML` on user data (only static jsonLd in
  `layout.tsx`); trace content rendered through React escaping.
- **Secrets:** no committed secrets (only fake test fixtures); security
  headers incl. CSP/HSTS/frame-deny in `next.config`.
- **SDK collectors:** OTLP collector binds `127.0.0.1` by default; MCP gateway
  logs only the upstream executable name (not args/env); gateway credentials
  stay local.
- **Body/rate bounds:** ingest 1 MB (8 MB decompressed), events 32 KB (256 KB
  decompressed), traces capped at 500 rows, graph at 2000, attributes 64 KB.

---

## Pass 1 — original audit (16 issues, all closed)

## 1. Authentication & Tenant Isolation
- **Status:** Fixed (migration `0010_tenant_isolation_ingest.sql`).
- **Was:** Single `SUPABASE_SERVICE_KEY` used for ingest/events/mcp; multi-tenancy depended on application-layer `user_id` filters.
- **Now:**
  - Dashboard reads/writes use `supaUserRequest()` + Clerk JWT → Postgres RLS (`user_id = auth.jwt()->>'sub'`), fail-closed in production.
  - Ingest / FOV events / MCP writes call `upsert_trace_for_key` / `insert_agent_event_for_key`, which resolve `key_hash → user_id` inside a `SECURITY DEFINER` function and stamp the tenant themselves. The service role can no longer choose an arbitrary `user_id` for those paths.

## 2. Rate Limiting
- **Status:** Fixed.
- **Was:** Silent per-isolate fallback when Upstash env vars were absent (effective limit × warm isolates).
- **Now:** Upstash is required in production. Missing `UPSTASH_REDIS_REST_*` fails closed (429) unless `SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT=1` is set explicitly. Health-check warns on misconfiguration. Dev/test keep the local map.

## 3. Data Integrity (truncation)
- **Status:** Fixed.
- **Was:** 64 KB wire body + 4 000-char field truncation dropped detail on complex agent traces.
- **Now:**
  - Ingest wire body cap: **1 MB** (decompressed bound 8 MB).
  - SDK `_safe_str` / ingest / MCP text fields: **32 000** chars.
  - Large free-text still redacted at the boundary; attributes remain capped at 64 KB JSON.

## 4. Cost Tracking
- **Status:** Previously addressed (bundled pricing fallback).

## 5. CI / License / Hygiene
- **Unit CI** no longer collects `tests/integration/` (`pytest --ignore=tests/integration` + pyproject `addopts`). Integration job overrides `addopts` and runs against Postgres.
- **LICENSE** (MIT) added to match the badge and `pyproject.toml`.
- **`.gitignore`** expanded (Python/Node/env/IDE artifacts).
- **`normalize_base_url`** handles empty / whitespace-only input without indexing errors.
- **`assets/logo.png`** recompressed (~1.5 MB → ~29 KB, 512² palette PNG).
