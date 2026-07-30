# SwarmTrace Security & Architecture Audit

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
