# Changelog

All notable changes to swarmtrace are documented here. Versions match PyPI
releases. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- bump `next` from 16.2.6 to 16.3.2 (Server Actions SSRF, middleware/Turbopack proxy bypass, cache confusion, Image Optimization DoS, and other advisories); this also pulls in patched `postcss` and `sharp`
- lockfile bumps for `fast-uri`, `qs`, `browserslist` and `postcss-selector-parser`; `npm audit` reports 0 vulnerabilities

### Added
- `tests/test_end_to_end.py`: runs the real stack with no fakes, from `@observe` through SQLite, the sender thread, gzip HTTP transport and a local server, to the CLI and export output
- `storage.close()` to release the shared SQLite connection; the next storage call reopens it
- `Sender.stop(timeout)` to stop and join the background worker

### Changed
- CI tests Python 3.10 and 3.12, and lints with the full ruff rule set from `pyproject.toml` (27 findings fixed)
- `pyproject.toml` classifiers list Python 3.10 to 3.13, license, audience and topic
- CLI tree view lists siblings in execution order and shows spans whose parent is outside the `--limit` window as detached roots
- the `/api/ingest` payload mapping lives in `SpanRecord.to_ingest_payload()` instead of two copies in `runtime.py` and `http_transport.py`
- `--limit` parsing is shared by `swarmtrace`, `swarmtrace-alerts list` and `swarmtrace-resync`

### Fixed
- fix CLI crash on NULL `latency_sec`
- fix `Sender` lifecycle races: a timed-out `stop()` left the sender accepting spans with no worker, and `stop()` could race `start()`; each worker now has its own stop event
- reject unrecognized arguments in `swarmtrace`, `swarmtrace-alerts list` and `swarmtrace-resync` (a typo like `--limti` used to run with defaults); `swarmtrace-alerts list --help` now prints help
- reject a bad `--limit` value with exit code 2
- `swarmtrace --help` and `swarmtrace-replay --help` print usage instead of running
- `swarmtrace-export --help` no longer writes a file, an unknown `--format` exits 2, and the command prints the row count and path (exit 1 if the file cannot be written)
- recreate the FOV `agent_events` table after the database path changes
- run the periodic WAL checkpoint after commit; it previously always hit `SQLITE_LOCKED`
- fix segfault when the SQLite connection was closed while the sender was writing
- narrow the `except ImportError` around rich rendering in `cli.py` to the imports only
- make the test suite collect on Python 3.10 (`tomllib` falls back to `tomli`)
- fix the Postgres integration test teardown to drop all migration functions and revoke grants

## [0.7.3] - 2026-08-20

### Fixed
- `fov._send_event_remote` now raises on failure so the 3-attempt retry loop works

### Changed
- finish the ruff `BLE001`/`S110`/`TRY004`/`SIM117`/`PYI034` cleanup: blind excepts are narrowed or carry a reasoned `noqa`, silent `except: pass` sites now log, `_SpanContext.__enter__`/`__aenter__` return `Self`

## [0.7.2] - 2026-08-08

### Changed
- clear about 558 ruff findings: import sorting, `Optional[X]` to `X | None`, builtin generics, unused imports and variables, merged nested `with`/`if`
- remove the executable bit from 8 test files

## [0.7.1] - 2026-08-07

### Security
- migration `0012` revokes `PUBLIC`/`anon`/`authenticated` on the legacy `upsert_trace`, `upsert_trace_with_metrics` and `increment_daily_metrics` RPCs (grant to `service_role` only) and pins `search_path = public`

### Changed
- migration `0012` wraps `auth.jwt() ->> 'sub'` in `(SELECT ...)` in every tenant-isolation RLS policy so Postgres evaluates it once per query

## [0.7.0] - 2026-08-05

### Security
- migrations 0010 and 0011 explicitly revoke `anon`/`authenticated` on the four `*_for_key` RPCs; a revoke from `PUBLIC` alone does not remove direct grants from Supabase default privileges
- the migration E2E simulates those default privileges and checks that only `service_role` can execute the RPCs

### Fixed
- `/api/ingest`, `/api/events` and `/api/regression` return `500 {error, code, hint}` for unmigrated or unavailable databases instead of an opaque 500; raw database errors stay in server logs
- add `lib/ingest-errors.ts` to classify failures as `SCHEMA_NOT_MIGRATED`, `DB_UNAVAILABLE`, `DB_TIMEOUT` or `DB_ERROR`
- add public, rate-limited `GET /api/health/db` schema check that lists `missingMigrations`
- add `npm run db:migrate` (`--status`, `--print [--all]`), which applies migrations in order with a `public.schema_migrations` ledger
- make all migrations idempotent with `DROP POLICY IF EXISTS` guards and `pg_publication_tables` checks
- `http_transport` raises `IngestHTTPError` with status and a bounded response body instead of a bare `HTTPError`
- migration 0005 drops `agent_events: owner only` before recreating it

### Added
- `docs/SUPABASE_SETUP.md`
- `frontend-next/scripts/e2e_migrations.py`, a migration E2E against a local Postgres (`pgserver`)
- tests: `test-ingest-errors.mjs`, `test-schema-health.mjs`, `tests/test_http_transport_errors.py`

## [0.6.9] - 2026-08-02

### Fixed
- remove a redundant `setSelectedId` effect in `NodeNetworkMap` that triggered `react-hooks/set-state-in-effect`
- use `aria-pressed` instead of `aria-selected` on `role="button"` elements in `app/traces/page.tsx` and `TraceTable.tsx`

## [0.6.8] - 2026-08-02

### Security
- MCP `record_trace` truncates text to 32 000 chars and PII-redacts it, and validates `attributes` (plain object, 64 KB max), via `lib/sanitize-mcp-trace.ts`

### Fixed
- Clerk-authenticated read routes return 401 instead of 500 on `RlsEnforcementError`
- correct the `[0.6.6]` date in this file

## [0.6.7] - 2026-08-02

### Added
- `swarmtrace.regression.compare(..., report_to_dashboard=True, run_name=...)` and `report_run()` upload regression runs to the new `POST /api/regression` route
- dashboard Regression page and `GET /api/regression`
- migration `0011_regression_runs.sql`: `regression_runs` table and `insert_regression_run_for_key`, following the 0010 tenant-isolation pattern
- reporting is best-effort: failures are logged, return `False` and never change the result of `compare()`
- text is truncated to 32 000 chars and redacted on the client and again at the ingest boundary
- `run_id` (1 to 64 chars of `[A-Za-z0-9_-]`) is the idempotency key; limits are 200 results per run and a 1 MB body, with rate limits on both routes
- tests: `tests/test_regression.py`, `scripts/test-regression.mjs`

## [0.6.6] - 2026-08-02

### Security
- migration `0010_tenant_isolation_ingest.sql` adds `resolve_api_key_user_id`, `upsert_trace_for_key` and `insert_agent_event_for_key`; `/api/ingest`, `/api/events` and `/api/mcp` take the tenant from the API key inside Postgres
- production rate limiting requires Upstash Redis; without `UPSTASH_REDIS_REST_*` requests get 429 unless `SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT=1`

### Fixed
- raise free-text caps from 4 000 to 32 000 chars and the ingest body limit from 64 KB to 1 MB (8 MB decompressed)
- unit CI no longer collects `tests/integration/`
- `normalize_base_url` accepts empty or whitespace-only input
- add the MIT `LICENSE` file and expand `.gitignore`
- compress `assets/logo.png` from about 1.5 MB to 29 KB

## [0.6.5] - 2026-07-12

### Changed
- `storage.py` returns dicts instead of tuples from `get_traces()`, `get_all_traces()`, `get_by_id()` and `get_unsynced_traces()`; `cli.py`, `replay.py`, `export.py`, `alerts.py` and `tracer.py` read fields by name
- remove the `_T_*` index constants from `alerts.py`
- `save_trace()` takes keyword-only arguments (breaking for external callers that passed positional args)

### Fixed
- MCP `record_trace` accepts `kind` (`agent`, `tool`, `llm`, `function`, `retrieval`) instead of always using `agent`; `agent_id` is required when `kind` is not `agent`; the logic is in `lib/resolve-trace-identity.ts` (frontend only)

## [0.6.4] - 2026-07-12

### Fixed
- fix `show_failures()` crash with `ValueError: too many values to unpack`
- JSON and CSV export include `session_id` and `synced`
- `swarmtrace.__version__` matches `pyproject.toml` (it was stuck at `0.5.0`)
- skip the OpenAI tests when `openai` is not installed
- `alerts.py` uses named column constants instead of `row[N]` (replaced in 0.6.5)

## [0.6.3] - 2026-07-12

### Fixed
- tree view nests grandchildren under their parent instead of flattening them into siblings
- tree view shows `✓`/`✗` status after the function name and truncates labels with an ellipsis instead of wrapping
- escape trace id brackets in rich markup so the id is displayed

### Added
- `tests/test_cli.py` tests for tree nesting and status indicators

## [0.6.2] - 2026-07-12

### Fixed
- fix `swarmtrace` CLI crash (`too many values to unpack (expected 14)`) now that `traces` has 16 columns
- tree view no longer wraps labels at 80 columns; full 32-char trace ids are kept because `swarmtrace-replay` needs them

### Added
- `tests/test_cli.py`: first tests for `view()` and `replay()`

## [0.6.1] - 2026-07-11

### Added
- `[project.urls]` in `pyproject.toml` (Homepage, Repository, Changelog, Issues, Documentation)

## [0.6.0] - 2026-07-11

### Changed
- `SWARMTRACE_ENDPOINT` must use `https://` unless the host is `localhost`, `127.0.0.1` or `::1`; other URLs log a warning and nothing is sent (breaking for plain-http endpoints)

### Fixed
- cap `args_repr` at 4000 chars like `output`; oversized rows could exceed the server body limit and be retried forever

## [0.4.10] - 2026-07-07

### Fixed
- distinct `@observe` lambdas in one scope no longer share an `agent_id`; the hash now includes `co_firstlineno` for lambdas

## [0.4.9] - 2026-07-05

### Added
- `observe(name=...)` overrides `agent_name` and seeds the stable `agent_id`

### Fixed
- bare `@observe` gets a stable `agent_id` (SHA-256 of `module.qualname`) so repeat runs form one agent instead of a new card per call
- `/api/agents` no longer requires `t.id === agent_id` in its group filter
- add `test_api_agents_filter_contract` covering the SDK and API agent grouping

### Known limitations
- traces recorded before this release keep their old random `agent_id`
- closures from the same factory share an `agent_id`; use `name=`

## [0.4.8] - 2026-07-05

### Added
- `patch_all()` / `init()` report which LLM SDKs are active
- FOV opt-in docs and an MCP quickstart in the README
- declare the `fov` extra in `pyproject.toml`

## [0.4.7] - 2026

### Fixed
- FOV: stop screenshots after the browser closes

## [0.4.6] - 2026

### Fixed
- endpoint URL 404 from an inconsistency between `tracer.py` and `fov.py`

## [0.4.5] - 2026

### Fixed
- import `numpy` lazily so `import swarmtrace` works without it

## [0.4.4] - 2026

### Changed
- FOV uses a background screen streamer instead of rate-limited screenshots

## [0.4.3] - 2026

### Fixed
- stability fixes for long-running agents

## [0.4.2] - 2026

- maintenance release

## [0.4.1] - 2026

### Changed
- rename `tracely` to `swarmtrace`

## [0.4.0] - 2026

- maintenance release

## [0.3.1] - 2026

### Added
- FOV live agent activity feed

## [0.3.0] - 2026

### Added
- span `kind` (`agent`, `tool`, `llm`, `function`) and attribution to the nearest enclosing agent span via `agent_id` / `agent_name`

## [0.2.0] - 2026

### Added
- budget monitoring, tool attention, web scraper, replay, `show_failures`

## [0.1.x] - 2026

- initial releases: `@observe`, SQLite storage, CLI, remote ingest, pricing, regression analysis
