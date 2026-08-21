# Changelog

All notable changes to **swarmtrace** are documented here. Versions match
PyPI releases. Format is loosely [Keep a Changelog](https://keepachangelog.com/),
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- **Bumped `next` from `16.2.6` to `16.3.2`**, resolving 9 high-severity
  advisories: Server Actions SSRF (custom servers and rewrites), a
  middleware/Turbopack proxy bypass, two response-cache confusion bugs,
  an unbounded Edge Server Action payload, an Image Optimization SVG DoS,
  and an unauthenticated disclosure of internal Server Function endpoints.
  The bump also pulled in patched `postcss` (CSS stringify XSS, source-map
  path traversal) and `sharp`/`libvips` (multiple CVEs) as transitive
  dependencies. `npm audit` now reports 0 vulnerabilities (was 11: 9 high,
  1 moderate, 1 low). Verified via `tsc --noEmit`, the full frontend test
  suite (267/267), and `next build`.

### Improved
- **The CLI tree no longer hides spans whose parent is outside the current**
  **`--limit` window.** These spans now render as detached roots, preserving
  visibility without inventing a false parent-child relationship.

### Fixed
- **Postgres integration-test teardown now removes every migration function**
  **and revokes role-owned grants before dropping its Supabase role stubs.**
  This fixes CI failing after all 14 assertions passed because
  `increment_daily_metrics(...)` still granted `EXECUTE` to `service_role`,
  and makes teardown resilient when future migrations add another RPC grant.

## [0.7.3] — 2026-08-20

### Fixed
- **`fov.py`'s `_send_event_remote` was silently swallowing its own**
  **exceptions**, which defeated the documented "retry up to 3 times with
  backoff" logic in its only caller: the outer `except Exception` could
  never fire because the inner function never raised. A remote FOV event
  send could fail outright and would never be retried. Now
  `_send_event_remote` raises on failure and the retry loop actually
  retries, logging a warning only after all 3 attempts are exhausted.

### Chore
- **Completed the `BLE001`/`S110`/`TRY004`/`SIM117`/`PYI034` audit left**
  **outstanding in 0.7.2** (99 findings total this pass — a few new ones
  landed on `main` since 0.7.2's snapshot). Every site was reviewed
  individually rather than blanket-suppressed:
  - `BLE001` (64) — the large majority are legitimate, deliberate
    boundaries (storage/network/teardown layers, background daemon loops,
    CLI entry points, arbitrary user-callback invocations, optional-SDK
    presence checks) and are now suppressed with a `# noqa: BLE001`
    explaining the specific reason. A smaller set were narrowed to the
    actual exception types the call site can raise
    (`otlp_mapping.py`, `span_model.py`, `alerts.py`'s timestamp parser).
    `budget.py` also had a redundant `(FuturesTimeout, Exception)` tuple
    collapsed to just `Exception` (the former is already a subclass of the
    latter), which made the now-unused `FuturesTimeout` import removable.
  - `S110` (7) — `alerts.py`'s `on_alert` callback now logs instead of
    silently dropping the exception; `delivery/sender.py`'s `task_done()`
    guard narrowed to `ValueError` with a debug log; `fov.py`'s four
    monkey-patch/streaming sites narrowed to their realistic exception
    types with debug logging; `tests/stress_api.py` now tracks and reports
    request failures instead of discarding them.
  - `TRY004` (4) — kept as `ValueError` with documented `noqa` in
    `gateway_config.py`: these validate parsed JSON config, not Python
    call arguments, and every *other* `isinstance` check in the same
    module (unflagged by this rule) already raises `ValueError`. Switching
    only the flagged four to `TypeError` would have split the module's
    error contract for external callers.
  - `SIM117` (3) / `PYI034` (2) — applied as planned in 0.7.2's notes:
    merged nested `with` in `test_resilience.py`/`test_run.py`;
    `_SpanContext.__enter__`/`__aenter__` now return `Self`, imported
    under `TYPE_CHECKING` since the package floors at py310 and
    `typing.Self` is py311+.
- Full suite re-verified clean after every file: 390 Python tests passed
  (14 skipped — no network/optional deps in the audit environment), `ruff
  check .` fully clean. Bumped to 0.7.3.

## [0.7.2] — 2026-08-08

### Chore
- **Cleared the ~558 non-critical ruff findings noted as outstanding in the**
  **0.7.1 audit** (import sorting, deprecated `typing` generics, unused
  imports/variables, and a handful of small simplifications) — down to 86,
  all deliberately left for human review (see below). None of this touches
  the CI-blocking subset (`E9,F63,F7,F82`), which was already clean.
- Modernized `Optional[X]` → `X | None` and `List`/`Dict`/`Tuple` → the
  builtin generics across `swarmtrace/` and `tests/` (target is already
  py310+), then removed the `typing` imports that became dead as a result.
  76 of those "unused import" removals were mechanical fallout from this
  rewrite; 4 were pre-existing and **not** touched because they're
  intentional: `mcp_gateway.py`'s `uvicorn` and the two SDK-presence checks
  in `test_auto_instrument.py` (`openai`/`anthropic`) only exist to trigger
  `ImportError` if the optional dependency is missing, and
  `replay.py`'s `from swarmtrace.cli import replay` is a documented
  backwards-compat re-export. All four now carry `# noqa: F401` explaining
  why.
- Fixed 8 test files that had the executable bit set with no shebang
  (`chmod -x`; they're pytest modules, never run directly).
- Collapsed a few nested `with`/`if` statements ruff considered safe to
  merge (`SIM117`/`SIM102`) and prefixed genuinely-unused unpacked/assigned
  variables with `_` (`RUF059`/`F841`) — all confirmed by hand to have zero
  other references before touching, then verified against the full suite.
- **Deliberately left unfixed** — these need case-by-case judgment, not a
  blanket pass, and several sites likely rely on the "failure isolation"
  pattern noted in earlier audits (swallowing errors so a transport/reporting
  failure can't break a caller's actual work):
  - `BLE001` (70) / `S110` (7) — blind `except`/`except: pass`. Narrowing
    each one requires knowing whether the broad catch is intentional
    isolation or a real gap; guessing wrong risks turning a deliberately
    silent failure path into a crash.
  - `TRY004` (4) — suggests `ValueError` → `TypeError` in a few spots.
    Changing the exception type a public function raises is a
    compatibility-sensitive decision, not a style fix.
  - `SIM117` (3) — nested `with` in `test_resilience.py` (unittest
    `assertLogs` + `patch`) and the async case in `test_run.py`; ruff itself
    declines to auto-fix these, unlike the 3 it merged without hesitation.
  - `PYI034` (2) — `_SpanContext.__enter__`/`__aenter__` returning `Self`
    instead of the concrete type. No runtime effect (no type checker runs
    in CI) and doing it correctly on a py310 floor needs either
    `from __future__ import annotations` or a version-guarded import;
    left for a deliberate pass rather than a rushed one.
- Full suites re-verified clean after every step: 404 Python tests, 267
  frontend tests, `tsc --noEmit`, eslint. Bumped to 0.7.2.

## [0.7.1] — 2026-08-07

### Security
- **Closed the legacy-RPC gap flagged in 0.7.0's note.** `upsert_trace`,
  `upsert_trace_with_metrics`, and `increment_daily_metrics` — the pre-0010
  RPCs that accept a caller-chosen `user_id` — were still callable by `anon`
  and `authenticated` on the production project. New migration `0012`
  formalizes the `docs/SUPABASE_SETUP.md` manual hardening script (revoke
  `PUBLIC`/`anon`/`authenticated`, grant `service_role` only) so `db:migrate`
  closes this automatically instead of depending on someone pasting SQL by
  hand. Also pins `search_path = public` on all three (Supabase's linter
  flagged them as mutable-search-path functions); no app code called any of
  them, so this is a pure attack-surface reduction with no behavior change.

### Performance
- **Fixed `auth_rls_initplan` on every tenant-isolation RLS policy**
  (`api_keys`, `traces`, `daily_metrics`, `agent_events`,
  `user_integrations`, `regression_runs`). Each policy compared `user_id`
  against a bare `auth.jwt() ->> 'sub'`, which Postgres re-evaluates once
  per row scanned instead of once per query. Migration `0012` wraps the
  call in `(SELECT auth.jwt() ->> 'sub')` so the planner treats it as an
  InitPlan. Same predicate, same semantics — matters increasingly as
  `traces` grows.

## [0.7.0] — 2026-08-05

### Security
- **Migrations 0010/0011 now revoke `anon`/`authenticated` explicitly on all
  four key-scoped RPCs** (`resolve_api_key_user_id`, `upsert_trace_for_key`,
  `insert_agent_event_for_key`, `insert_regression_run_for_key`). The previous
  `REVOKE ALL ... FROM PUBLIC; GRANT ... TO service_role` pattern is
  insufficient on Supabase projects whose default privileges
  (`ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS`) hand
  `anon`/`authenticated` a **direct** execute grant on newly created
  functions — direct grants survive a `PUBLIC` revoke. This gap made
  `insert_regression_run_for_key` callable by `anon`/`authenticated` in one
  production project (mitigated there live; callers still needed a valid
  `key_hash`, and no app code relied on the access). The migration E2E now
  simulates Supabase-style default privileges and asserts both halves of the
  invariant: no `*_for_key` RPC is executable by `PUBLIC`/`anon`/
  `authenticated`, and `service_role` keeps `EXECUTE` on all of them.
  **Note:** the pre-0010 legacy RPCs (`upsert_trace_with_metrics`,
  `upsert_trace`, `increment_daily_metrics`) still carry no revokes; if your
  project has such default privileges, revoke them manually (see
  `docs/SUPABASE_SETUP.md`) — they accept a caller-chosen `user_id`.

### Fixed
- **Root-caused "valid API key, zero traces on dashboard": unmigrated
  Supabase projects now fail loudly with the remedy, end to end.** A
  deployment whose Supabase project never had `supabase/migrations/` applied
  (e.g. only `0000` was run — enough to create an API key in Settings)
  failed every `POST /api/ingest` at the `upsert_trace_for_key` RPC with
  PostgREST `PGRST202`; the route collapsed that to an opaque
  `500 {"error":"Internal server error"}`, and the Python SDK discarded even
  that body (`HTTPError` stringifies to `HTTP Error 500: Internal Server
  Error`). The result was indistinguishable from an auth fault and
  undiscoverable without Vercel function logs. Fixed at every layer:
  - **Server:** new `lib/ingest-errors.ts` classifies Supabase/PostgREST
    failures (`SCHEMA_NOT_MIGRATED` / `DB_UNAVAILABLE` / `DB_TIMEOUT` /
    `DB_ERROR`); `/api/ingest` (key-lookup and trace-write stages
    separately), `/api/events`, and `/api/regression` now return
    `500 {error, code, hint}` where `hint` names the fix. Raw database error
    text goes to server logs only — never to anonymous callers.
  - **New `GET /api/health/db`:** public, read-only, per-IP rate-limited
    schema self-check. Verifies every table/column group the app uses and
    probes all four `*_for_key` RPCs by **full signature** with a fake key
    hash (they answer `invalid_api_key` after signature matching, so the
    check writes nothing). Returns `missingMigrations` with the exact files
    to run. `200` ok / `503` degraded (`docs/SUPABASE_SETUP.md`).
  - **One-command migrations:** `frontend-next/scripts/run-migrations.mjs`
    (`npm run db:migrate`, `--status`, `--print [--all]`) applies
    `supabase/migrations/*.sql` in order with a `public.schema_migrations`
    ledger, one transaction per file. No new npm dependencies (uses `psql`;
    `--print` emits a SQL-editor-pasteable bundle without any tooling).
  - **All migrations are now strictly idempotent:** `0001/0002/0004/0005/
    0006` gain `DROP POLICY IF EXISTS` guards, and `0002/0004/0005`
    publication changes use `pg_publication_tables`-checked `DO` blocks —
    pasting the bundle into a partially-migrated project converges instead
    of erroring halfway.
  - **SDK:** `swarmtrace.adapters.http_transport` now raises
    `IngestHTTPError` (status + bounded server response body) instead of
    raw `urllib.error.HTTPError`, so `remote ingest failed` logs actually
    contain the server's `SCHEMA_NOT_MIGRATED` hint. Retry/keep-unsynced
    semantics unchanged.
  - Migration 0005 additionally drops `agent_events: owner only` before
    recreating it (re-run safety fix).

### Added
- `docs/SUPABASE_SETUP.md` — dashboard backend setup: projects → migrations
  → env vars → `/api/health/db` verification → API key, plus a
  symptom→cause→fix troubleshooting table.
- `frontend-next/scripts/e2e_migrations.py` — full-stack migration E2E on a
  pristine local Postgres (`pgserver`): applies all files via the runner,
  re-applies them raw, and exercises `upsert_trace_for_key` exactly as
  `/api/ingest` does (named 18-arg call, tenant stamping, daily_metrics,
  idempotent retry).
- Tests: `test-ingest-errors.mjs`, `test-schema-health.mjs` (PostgREST
  simulator covering fresh-project/healthy/stale-signature/permission/
  unreachable shapes), `tests/test_http_transport_errors.py`.

## [0.6.9] — 2026-08-02

### Fixed
- **NodeNetworkMap cascading-render hazard (external review finding):** the
  auto-select effect called `setSelectedId(nodes[0].id)` synchronously once
  the layout resolved — flagged as an error by the React Compiler lint rule
  (`react-hooks/set-state-in-effect`). The effect was fully redundant: the
  component already derives `selected = nodes.find(...) ?? nodes[0]`, so the
  first node is auto-selected by the fallback and an explicit user selection
  always wins (preserved across graph refreshes). Effect removed; behavior
  unchanged.
- **Two jsx-a11y violations: `aria-selected` on `role="button"`** in
  `app/traces/page.tsx` and `components/swarm/TraceTable.tsx` (external
  review finding). `aria-selected` is not supported by the `button` role;
  replaced with `aria-pressed`, which conveys the toggle/selected state to
  assistive technology correctly.
- Full frontend re-validation after the fixes: eslint 0 errors (1 benign
  TanStack Virtual informational warning), `tsc --noEmit` clean, 249/249
  unit tests pass, production build green.

## [0.6.8] — 2026-08-02

### Security
- **MCP `record_trace` now redacts at the boundary (audit pass 2, finding 1):**
  `/api/mcp` previously passed `args`/`output`/`error`/`attributes` straight
  into `upsert_trace_for_key` — and MCP is the one path where non-SDK clients
  (Hermes, Claude Desktop, Cursor) never run the Python SDK's client-side
  redaction, so API keys embedded in tool-call arguments landed unredacted in
  the database. `lib/sanitize-mcp-trace.ts` now truncates to 32 000 chars and
  PII-redacts text fields (same rules as the ingest boundary), validates
  `attributes` as a plain object capped at 64 KB JSON (mirroring ingest), and
  rejects invalid attributes with `isError`. 9 unit tests in
  `scripts/test-mcp-sanitize.mjs`.

### Fixed
- **Clerk-authenticated read routes return 401 (not 500) when RLS
  enforcement fails** (audit pass 2, finding 2): `agents`, `traces`, `graph`,
  `metrics`, `overview`, `billing`, and `settings/api-keys` GET now convert
  `RlsEnforcementError` to 401, matching the settings write routes. Fail-closed
  either way — this aligns semantics, logs, and client errors.
- **CHANGELOG `[0.6.6]` date corrected** from 2026-03-24 to 2026-08-02
  (audit pass 2, finding 3) — restores newest-first ordering.
- Full pass-2 audit notes in `AUDIT_REPORT.md`.

## [0.6.7] — 2026-08-02

### Added
- **Dashboard exposure for prompt-regression runs** — the item docs/PRD.md §17
  flagged as unfinished. `swarmtrace.regression.compare()` can now report runs
  to the dashboard:
  - `compare(..., report_to_dashboard=True, run_name="...")` uploads the run
    (per-input similarity scores, latencies, and redacted prompt/output text)
    to the new `POST /api/regression` route, authenticated with the SwarmTrace
    API key. New public `report_run()` does the same without `compare()`.
  - New dashboard **Regression** page (sidebar → Analyze → Regression) lists
    reported runs with per-input similarity bars, regression flags, and
    latency comparison; new `GET /api/regression` serves it (Clerk JWT +
    Postgres RLS).
  - New migration `0011_regression_runs.sql`: `regression_runs` table +
    `insert_regression_run_for_key` SECURITY DEFINER function, following the
    migration 0010 tenant-isolation pattern (key_hash → user_id stamped inside
    Postgres; the app never chooses the tenant on the write path).
- Reports are **best-effort and safe by construction**: a missing/unconfigured
  key, network failure, or HTTP error is logged and returns `False` — it never
  raises and never changes `compare()`'s return value. Text is truncated to
  32 000 chars and PII-redacted client-side before transmission, and redacted
  again at the ingest boundary (`lib/validate-regression.ts`).
- Payload contract: `run_id` (1–64 chars `[A-Za-z0-9_-]`) is the per-user
  idempotency key (`ON CONFLICT DO NOTHING` — SDK retries can't duplicate a
  run), max 200 result entries per run, 1 MB body cap, per-key + per-IP rate
  limits on the write route, per-user rate limit on the read route.
- New tests: `tests/test_regression.py` (9 new cases covering the upload
  path, redaction/truncation, failure isolation, fresh run ids) and
  `scripts/test-regression.mjs` (17 cases covering the payload contract).

## [0.6.6] — 2026-08-02

### Security
- **Multi-tenant isolation (ingest path):** new migration `0010_tenant_isolation_ingest.sql` adds `resolve_api_key_user_id`, `upsert_trace_for_key`, and `insert_agent_event_for_key`. `/api/ingest`, `/api/events`, and `/api/mcp` now bind tenant identity to the API key inside Postgres instead of trusting an app-layer `user_id` with the service-role key.
- **Rate limits:** production requires Upstash Redis. Missing `UPSTASH_REDIS_REST_*` fails closed (429) unless `SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT=1` is set. Health-check surfaces the misconfiguration.

### Fixed
- Raised SDK/ingest/MCP free-text caps from 4 000 → **32 000** chars and ingest wire body from 64 KB → **1 MB** (8 MB decompressed) so complex agent traces keep detail.
- Unit CI no longer collects `tests/integration/` (pyproject `addopts` + workflow `--ignore`); integration job overrides `addopts`.
- Added MIT `LICENSE` (badge and packaging already claimed MIT).
- Expanded root `.gitignore` (venv, coverage, Next/Node, IDE, env files).
- `normalize_base_url` no longer errors on empty/whitespace-only input.
- Compressed `assets/logo.png` (~1.5 MB → ~29 KB).

## [0.6.5] — 2026-07-12

### Changed
- **`storage.py` now returns dicts instead of tuples** (`swarmtrace/storage.py`):
  `get_traces()`, `get_all_traces()`, `get_by_id()`, and `get_unsynced_traces()`
  all return `List[dict]` / `Optional[dict]` now (using `sqlite3.Row` +
  `dict(row)` at the API boundary). `TraceRow` is now `Dict[str, Any]`.
  Consumers access fields by name (`row["agent_name"]`) instead of by
  positional index (`row[13]`). This permanently eliminates the tuple-unpack
  bug class that caused `cli.py` / `replay.py` / `export.py` to break silently
  when `session_id` + `synced` columns were added — and would have broken again
  on the next schema migration. Every consumer updated: `cli.py`, `replay.py`,
  `export.py`, `alerts.py`, `tracer.py`'s `_row_to_payload`. The stopgap
  `_T_*` named-index constants added to `alerts.py` in 0.6.4 have been removed
  (the dict refactor supersedes them). Phase 2 of the audit fix plan.

- **`save_trace()` is now keyword-only** (`swarmtrace/storage.py`): the
  signature changed from positional to `def save_trace(*, id_, parent_id, ...)`.
  This prevents the "wrong data in wrong column" class of bug — adding or
  reordering a parameter no longer requires simultaneous update of all 5
  callers (it bit `auto_instrument.py` when `session_id` was added). All
  internal callers updated. **⚠️ Breaking change for external callers** who
  called `save_trace()` with positional args — switch to keyword args. The
  main user-facing API (`@observe`, `init`, `session`) is unaffected.

### Fixed
- **MCP `record_trace` no longer hardcodes `kind='agent'`**
  (`frontend-next/app/api/mcp/route.ts`): line 150 had `const kind = 'agent'`
  regardless of what the caller sent — every MCP trace got tagged `agent` and
  nested tool/llm/function spans were indistinguishable from top-level agent
  spans. The Python SDK properly distinguishes `agent`/`tool`/`llm`/`function`
  via `@observe(kind=...)`; MCP couldn't distinguish anything. Fix: `record_trace`
  schema gains a `kind` param (`z.enum(['agent','tool','llm','function','retrieval']).default('agent')`).
  Because MCP calls are stateless (no contextvar to infer the enclosing
  agent from), `agent_id` is now **required** when `kind` is not `'agent'` —
  the tool returns `isError` instead of silently misattributing. `kind='agent'`
  behavior is unchanged (agent_id still defaults to stable SHA-256 of
  `function`). Resolution logic extracted to `lib/resolve-trace-identity.ts`
  (10 new unit tests in `scripts/test-resolve-trace-identity.mjs`). Phase 3
  of the audit fix plan. **Frontend-only — ships with the Next.js deployment,
  not the PyPI package.**

### Notes
- This release addresses the dict refactor (Phase 2) and the MCP kind fix
  (Phase 3) from the audit's recommended action plan. Phase 4 (Postgres
  integration test in CI) is in progress.
- 198 Python tests pass (unchanged from 0.6.4 — the dict refactor was
  behavior-preserving). 155 frontend tests pass (was 145, +10 new for
  `resolveTraceIdentity`).

## [0.6.4] — 2026-07-12

### Fixed
- **`show_failures()` no longer crashes with `ValueError: too many values to
  unpack`** (`swarmtrace/replay.py`): same bug class as the CLI crash fixed in
  0.6.2, but `replay.py:32` was missed in that release. The 14-field tuple
  unpack couldn't handle the 16-column trace row (after `session_id` + `synced`
  migrations). Fix: append `*_` to swallow trailing columns. Found by
  independent audit (Arena.ai Agent Mode).

- **JSON/CSV export no longer drops `session_id` and `synced` fields**
  (`swarmtrace/export.py`): `_traces_to_dicts()` had a 14-key list that
  silently dropped the two migration columns from every export. Thread
  grouping (`session_id`) and sync status (`synced`) were missing from all
  JSON and CSV exports since the columns were added. Fix: add both keys to
  the list. Found by independent audit.

- **`swarmtrace.__version__` now matches `pyproject.toml`** (`swarmtrace/__init__.py`):
  `__version__` was hardcoded as `'0.5.0'` and never bumped through 4 releases
  (0.6.0, 0.6.1, 0.6.2, 0.6.3). Anyone calling `swarmtrace.__version__` got a
  stale answer. Fix: bump to `'0.6.4'`. Both `__init__.py` AND `pyproject.toml`
  bumped together in this release to stay in sync. Found by independent audit.

- **OpenAI tests no longer hard-fail when `openai` package is missing**
  (`tests/test_auto_instrument.py`): the 4 OpenAI test functions imported
  `openai` at module top without a `skipif` guard. CI environments without
  `openai` installed showed 4 hard failures (not skips). The Anthropic tests
  already had the guard; OpenAI tests didn't. Fix: added `_has_openai()`
  helper and `@pytest.mark.skipif(not _has_openai(), ...)` to all 4 OpenAI
  test functions, mirroring the existing Anthropic pattern. Found by
  independent audit.

- **`alerts.py` no longer uses raw `row[N]` positional indexing**
  (`swarmtrace/alerts.py`): the three alert rules (`budget_breach`,
  `error_spike`, `latency_regression`) accessed trace-row fields by raw
  positional index (`row[13]` for agent_name, `row[10]` for cost, etc.).
  This is the same fragility class as the CLI/replay/export tuple-unpack
  bugs — a future schema migration would silently shift every index and
  break alert rules in subtle ways (e.g. `budget_breach` would read the
  wrong field as cost). Not currently broken (indices match the 14-column
  layout), but fragile. Fix: defined named column-index constants
  (`_T_ID`, `_T_COST`, `_T_AGENT_NAME`, etc.) at module top and replaced
  all raw indexing with the constants. The permanent fix is to refactor
  `storage.py` to return dicts (planned for next release); this is a
  stopgap that makes the fragility visible and gives a single place to
  update if the schema changes. Found by independent audit.

### Notes
- This release addresses 5 of the 17 bugs found by an independent audit
  (Arena.ai Agent Mode). The remaining 12 bugs are scheduled for future
  releases — see the audit's recommended action plan. The most important
  remaining fix is refactoring `storage.py` to return `List[dict]` instead
  of `List[tuple]`, which eliminates the entire tuple-unpack bug class
  permanently.

## [0.6.3] — 2026-07-12

### Fixed
- **Tree view no longer flattens grandchildren into siblings** (`swarmtrace/cli.py`):
  commit 2655ec9 (shipped in 0.6.2) introduced a regression in the
  `add_children` recursion — it recursed into `tree_node` (the parent)
  instead of `branch` (the newly created child node), so any trace with
  3+ levels (e.g. `agent → sub_agent → tool_call`) had the grandchild
  rendered as a sibling of its parent instead of nested under it:
  ```
  root_agent()
  ├── sub_agent()          ← correct
  └── tool_call() (tool)   ← WRONG: should be nested under sub_agent
  ```
  Fix: `add_children(branch, cid)` — recurse into the new branch, not
  the parent. Found by an independent code review of the 0.6.2 diff.

- **Tree view restores status indicators (✓/✗) lost in 0.6.2**
  (`swarmtrace/cli.py`): commit 2655ec9 dropped the `OK`/`ERROR` suffix
  from tree branches entirely to prevent 80-col wrapping, but that was
  a usability regression — users couldn't see which nested call failed
  without cross-referencing the flat table. Fix: restore status using
  compact `✓`/`✗` indicators placed RIGHT AFTER the function name
  (protected from ellipsis truncation), and wrap each label in
  `Text(no_wrap=True, overflow="ellipsis")` so rich truncates with `…`
  instead of word-wrapping. Field order changed to
  `func → status → kind-tag → latency → cost → id` so the most
  scannable info is first and the long trace ID is last (where
  truncation is least harmful — the full ID is still in the table
  view above and via `swarmtrace-replay <id>`).

- **Trace ID brackets escaped in rich markup** (`swarmtrace/cli.py`): the
  `[trace_id]` brackets were being interpreted as rich style tags by
  `Text.from_markup()`, silently dropping the ID from the rendered output.
  Fix: escape as `\[trace_id]` so rich treats the brackets as literal.

### Added
- Two new regression tests in `tests/test_cli.py`:
  - `test_view_tree_nests_grandchildren_correctly`: seeds a 3-level trace
    and asserts the grandchild is indented deeper than its parent.
  - `test_view_tree_shows_status_indicators`: asserts both `✓` (OK) and
    `✗` (ERROR) appear in the tree output. 198 tests pass (was 196).

## [0.6.2] — 2026-07-12

### Fixed
- **`swarmtrace` CLI no longer crashes with `ValueError: too many values to
  unpack (expected 14)`** (`swarmtrace/cli.py`): `view()` and `replay()`
  unpacked exactly 14 fields from each trace row, but the `traces` table
  actually has 16 columns after the `session_id` and `synced` migrations
  (`storage.py:_ADDED_COLUMNS`). `SELECT *` returned 16 values, the tuple
  unpack raised, and the `swarmtrace` CLI crashed on every invocation after
  any trace was recorded — meaning every new user who ran `pip install
  swarmtrace`, decorated a function, and then ran `swarmtrace` to view their
  traces hit an immediate crash. Reproduced live by running the dogfood RAG
  agent against `mistral-large-latest` and then running `swarmtrace` to view
  the trace. Fix: append `*_` to every unpack in `cli.py` (6 sites) so
  trailing columns are swallowed. Future migration columns won't rebreak
  this.

- **Tree view no longer wraps branch labels onto a second line at 80 cols**
  (`swarmtrace/cli.py`): the tree view rendered every branch with a trailing
  `OK` / `ERROR` suffix, duplicating the Status column already shown in the
  table view above. The extra suffix pushed branch labels like
  `mistral_answer() (llm) [32-char-uuid] 0.608s $0.000236 OK` past 80 cols,
  and `rich.Tree` wrapped the trailing `OK` onto a second line, breaking the
  indentation:
  ```
  ├── mistral_answer() (llm) [41c2494b...] 0.608s $0.000236
  │   OK                                                          ← BROKEN
  ```
  Fix: drop the status suffix from the tree view (errors are still visible
  in the table view; users who want full detail use `swarmtrace-replay
  <id>`). Also pass `soft_wrap=True` to `console.print(tree)` so any future
  length growth truncates cleanly instead of wrapping. **Full 32-char trace
  IDs are preserved** — `swarmtrace-replay <id>` does an exact `get_by_id()`
  lookup and needs the full UUID. An earlier attempt truncated IDs to 8
  chars for aesthetics; reverted after realizing this breaks the replay
  workflow.

### Added
- **`tests/test_cli.py`** — first ever coverage for `view()` and `replay()`.
  The bug shipped because neither function had a test. Seven cases:
  full-schema unpack, empty DB, error rows, replay full-schema, replay
  missing trace, full 32-char trace ID preservation, tree-view no-wrap at
  80 cols. All exercise the real storage layer against a temp DB (no mocks).
  196 tests now pass (was 189).

## [0.6.1] — 2026-07-11

### Added
- **Project URLs in `pyproject.toml`** (`[project.urls]` section): Homepage,
  Repository, Changelog, Issues, Documentation. PyPI now links to the website
  (https://swarmtrace.vercel.app) and GitHub repo from the package page. This
  gives Google an authoritative inbound link to the site from pypi.org (one of
  the most highly-indexed domains), which helps with search discovery
  independently of sitemap submission. No code changes — metadata-only release.

## [0.6.0] — 2026-07-11

### Fixed
- **`args_repr` now capped at 4000 chars to match `output`** (`swarmtrace/tracer.py`):
  `_flush` was doing `args_repr = str(args[:2])` (no cap) while `output` went
  through `_safe_str(result)` (capped at 4000). A function called with one
  large argument (big string, dataframe repr, base64 screenshot, etc.) produced
  a trace whose `args` field was unbounded while `output` was exactly 4000 chars.
  Downstream: the oversized row could push its batch over the server's
  `MAX_BODY_BYTES = 64KB` → 413 → `resync()` retries the row forever (it never
  fits), never marks it `synced=1`, and it silently leaks in the local SQLite
  DB forever while burning retry time on every resync run. Confirmed live with
  non-compressible base64 args (the real-world case — repetitive `XXXX...`
  gzips 250:1 and hid the bug). Fix: `args_repr = _safe_str(args[:2])` so both
  fields cap at 4000. After fix, the previously-oversized batch gzips to ~3.4KB
  and syncs cleanly. Audit finding #3.

### Changed
- **`SWARMTRACE_ENDPOINT` now requires `https://` (or localhost)** (`swarmtrace/tracer.py`):
  `_normalize_base_url` previously accepted any string, so
  `SWARMTRACE_ENDPOINT=http://example.com` would silently send the API key
  over plaintext HTTP with zero warning. New `_validate_endpoint_scheme(url)`
  function rejects non-https URLs unless the host is `localhost`, `127.0.0.1`,
  or `::1`. When rejected, `_remote_config` logs a warning AND returns an empty
  URL — the worker skips sending (matching the "no endpoint configured" path)
  so the API key never goes over the wire. **⚠️ Breaking change for SDK users
  with `SWARMTRACE_ENDPOINT=http://non-localhost`:** the SDK will refuse to
  send traces after upgrading. Switch to `https://`, or use
  `http://localhost:...` for local dev. RFC1918 IPs (`192.168.x.x`, `10.x.x.x`)
  are intentionally NOT excepted — they're often used for internal services
  that may not be as trusted as a dev loopback. Users who need them can set up
  HTTPS locally (mkcert, caddy). Audit finding #5.

### Notes
- This version also includes frontend-side audit fixes (key-cache revocation
  redesign, `truncated` indicator in dashboard UI) that ship with the Next.js
  deployment, not the PyPI package. See PR #16 for the full breakdown.

## [0.4.10] — 2026-07-07

### Fixed
- **Lambda disambiguation for stable `agent_id`** (`swarmtrace/tracer.py`):
  two distinct `@observe` lambdas in the same scope used to silently
  collapse into one dashboard agent card because all lambdas share the
  `__qualname__` `<lambda>` (or `outer.<locals>.<lambda>`). The
  `_stable_agent_id` derivation now appends `co_firstlineno` to the hash
  source when `<lambda>` appears in the qualname. Line number is stable
  across calls of the same lambda (so repeat runs still aggregate) but
  differs between distinct lambdas (so they don't collide). Named
  functions are unaffected — refactoring (moving a function to a
  different line) must not break aggregation. Closures from the same
  factory still share a source line by definition, so they keep the
  documented limitation (use `name=` to disambiguate).

## [0.4.9] — 2026-07-05

### Fixed
- **Stable `agent_id` for bare `@observe`** (`swarmtrace/tracer.py`): repeated
  invocations of the same top-level `@observe` function used to get a fresh
  random `agent_id` per call (equal to that call's `trace_id`). Combined with
  the dashboard grouping strictly by `agent_id`, every run of the same agent
  showed up as a *new* agent card with `tasks: 1`, instead of one persistent
  agent whose task count climbed over time. Now `agent_id` is derived from a
  SHA-256 of `"{module}.{qualname}"`, so repeat runs collapse into one identity.
- **Matching `/api/agents` filter** (`frontend-next/app/api/agents/route.ts`):
  dropped the `t.id === agent_id` check from the group filter. That check was
  an artifact of the old `agent_id = trace_id` invariant and would have
  silently dropped every bare-`@observe` agent under the stable-id scheme
  (zero agent cards on the dashboard). The `kind === 'agent'` check alone is
  sufficient — orphan tool/llm/function spans still don't become phantom
  agents because their `kind !== 'agent'`.
- **SDK ↔ API contract test** (`tests/test_tracer.py::test_api_agents_filter_contract`):
  reproduces the exact `/api/agents` filter logic against real tracer output.
  Covers all four `agent_id` regimes (bare `@observe` aggregation, explicit
  swarm sub-agents, nested non-agent rollup, orphan phantom prevention). Any
  future change to EITHER the SDK's `agent_id` assignment OR the API filter
  that breaks the contract fails here instead of silently breaking the
  dashboard.

### Added
- **`observe(name=...)` parameter**: optional string that overrides the
  displayed `agent_name` AND seeds the stable `agent_id` hash instead of
  `func.__qualname__`. Useful when the same function represents different
  agents based on runtime config, or when you want a human-readable id source.
  Ignored for the `agent_id` of explicit `kind="agent"` (those keep fresh
  per-call ids), but still overrides `agent_name` for readability.

### Changed
- Existing tests in `test_tracer.py` and `test_auto_instrument.py` updated to
  read `agent_id` from position `-2` (the field) instead of `0` (the row id)
  since they're no longer equal for bare `@observe`. Semantics each test
  encodes are unchanged.

### Known limitations
- Historical traces in users' DBs retain old random `agent_id`s and will
  appear as orphan agent cards until they age out of the 500-row window.
  New runs get the stable hash and aggregate correctly. One-time migration
  pain, not permanent.
- ~~Two `@observe` lambdas in the same scope share `__qualname__` (`<lambda>`)
  and would collapse into one agent. Workaround: use `@observe(name='a')`.~~
  **Resolved in [0.4.10]** — line-number disambiguation added.
- Closures created from the same factory function share `__qualname__` and
  would collapse. Workaround: same — use `name=`.

## [0.4.8] — 2026-07-05 (preceding 0.4.9 by hours)

### Added
- `patch_all()` / `init()` self-reports which LLM SDKs are active.
- FOV opt-in documentation + MCP quickstart in README.
- `fov` extra declared in `pyproject.toml` (was implicit before).

## [0.4.7] — 2026

### Fixed
- FOV: stop screenshot spam after browser closes.

## [0.4.6] — 2026

### Fixed
- Endpoint URL 404 (inconsistency between `tracer.py` and `fov.py`).

## [0.4.5] — 2026

### Fixed
- Lazy-import `numpy` so `import swarmtrace` works without `numpy` installed
  (only needed for the optional `tools` extra).

## [0.4.4] — 2026

### Changed
- Replaced rate-limited screenshots with a background screen streamer for FOV.

## [0.4.3] — 2026

### Fixed
- 24/7 production hardening (various stability fixes for long-running agents).

## [0.4.2] — 2026

Maintenance version bump.

## [0.4.1] — 2026

### Changed
- Renamed all `tracely` references to `swarmtrace`.

## [0.4.0] — 2026

Maintenance version bump.

## [0.3.1] — 2026

### Added
- FOV: live agent activity feed.

## [0.3.0] — 2026

### Added
- Span taxonomy: every traced call now has a `kind`
  (`'agent' | 'tool' | 'llm' | 'function'`) and is attributed (via
  `agent_id` / `agent_name`) to the nearest enclosing `kind='agent'` span.
  This is the foundation for the dashboard's Agents page.

## [0.2.0] — 2026

### Added
- Budget monitoring, tool attention, web scraper, replay, `show_failures`.

## [0.1.x] — 2026

Initial releases. Core `@observe` decorator, SQLite storage, CLI, remote
ingest, pricing calculation, regression analysis.
