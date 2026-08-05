# Dashboard backend setup (Supabase + Vercel)

Step-by-step for deploying the SwarmTrace dashboard yourself (or for fixing
an existing deployment where **traces never show up**).

> **Symptom this doc fixes:** the dashboard loads, you created an API key,
> your SDK prints `remote ingest failed after 3 attempts: HTTP Error 500`,
> and nothing ever appears on the dashboard. That is almost always
> *step 2 below was skipped* — the Supabase migrations were never applied.

---

## 1. Create the projects

1. **Supabase:** create a project at [supabase.com](https://supabase.com).
   Note the project URL (`https://<ref>.supabase.co`) and, from
   *Project Settings → API*, the `anon` key and the `service_role` key
   (keep the service key secret — server-side only).
2. **Clerk:** create an application at [clerk.com](https://clerk.com) for
   dashboard sign-in. Note `pk_...` / `sk_...` from *API Keys*.

## 2. Apply the database migrations  ⚠️ the step everyone misses

Everything the dashboard needs — tables, RLS policies, and the
`upsert_trace_for_key` RPC used by `/api/ingest` — is created by the SQL
files in [`supabase/migrations/`](../supabase/migrations/), which must be
applied **in filename order**.

### Option A — the runner (recommended)

```bash
cd frontend-next
# Postgres connection string: Supabase Dashboard → Project Settings →
# Database → Connection string (URI). Put it in .env.local or export it:
export SUPABASE_DB_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres"

npm run db:migrate    # applies pending migrations, records them in public.schema_migrations
npm run db:status     # show applied vs pending
```

Full mode list: `node scripts/run-migrations.mjs --help`. Notes:

- Requires `psql` on PATH (`brew install libpq`, `apt install postgresql-client`).
- IPv4-only network and the direct (5432) host won't connect? Use the
  *session pooler* host (`...pooler.supabase.com:5432`) from the same page.
- Re-running is safe: each migration runs in one transaction and is
  recorded; applied ones are skipped.

### Option B — the Supabase SQL editor (no tooling needed)

```bash
cd frontend-next
node scripts/run-migrations.mjs --print --all   # prints all migrations as one script
```

Paste the output into *Supabase Dashboard → SQL Editor → New query* and run
it. The files are idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`,
`DROP POLICY IF EXISTS`, guarded publication changes), so pasting over a
partially-migrated project converges to the right state.

## 3. Configure environment variables

In **Vercel → Project → Environment Variables** (and `frontend-next/.env.local`
for dev) — every value from [`.env.example`](../frontend-next/.env.example):

| Variable | From |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk → API Keys |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase → API (service_role!) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → API (anon) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | [console.upstash.com](https://console.upstash.com) — required in production for durable rate limits |
| `SUPABASE_DB_URL` *(migrations only, not needed at runtime)* | Supabase → Database |

Redeploy after changing env vars.

## 4. Verify — the self-check endpoint

```bash
curl https://<your-dashboard>/api/health/db
```

- `200 {"ok":true,...}` — schema complete, RPC signatures current.
- `503 {"ok":false,"missingMigrations":["0010_tenant_isolation_ingest.sql",...], "hint":...}`
  — exactly which migrations are missing; apply them (step 2) and re-check.
- `503 {"error":"not_configured"}` — `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`
  not set on the deployment.

The endpoint is public, read-only (never reads user data), and per-IP rate
limited. It probes each SECURITY DEFINER RPC with a fake key hash — the
functions reject it with `invalid_api_key` **after** signature matching, so
a current signature is confirmed without writing any rows.

## 5. Create your API key and trace

1. Open the dashboard, sign in (Clerk), go to **Settings → API Keys →
   Create**. (Hobby plan: 1 key.)
2. Point the SDK at it:
   ```python
   from swarmtrace import init, observe
   init(api_key="st_...", endpoint="https://<your-dashboard>")
   ```
3. Run your agent; traces arrive within ~2 s. If the SDK ever fails to
   deliver, rows stay durable in `~/.swarmtrace.db` and
   `swarmtrace-resync` replays them.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `HTTP Error 500` + `SCHEMA_NOT_MIGRATED` in SDK logs (server response body is now surfaced) | Migrations missing/behind | Step 2, then `/api/health/db` |
| `HTTP Error 401` + `Invalid or revoked API key` | Wrong key, or key revoked in Settings | New key in Settings → API Keys |
| `HTTP Error 429` | Rate limited (120 ingests/min/key) | Back off; resync later |
| Dashboard pages all 401 | Clerk↔Supabase native integration not set up | Migration 0005's header comment has the click-path; also check `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Dashboard loads but shows nothing while ingest succeeds | Traces are arriving under a different user/project, or Realtime isn't streaming (live-only views) | `/api/traces` via your session; verify Clerk integration; hard-refresh |
| `not_configured` from `/api/health/db` | env vars missing on Vercel | Step 3 + redeploy |

## Validating migration changes (contributors)

`frontend-next/scripts/e2e_migrations.py` migrates a pristine local Postgres
(via the `pgserver` pip package — bundled binaries, no Docker) twice,
re-applies every file raw, and exercises `upsert_trace_for_key` exactly the
way `/api/ingest` does:

```bash
pip install pgserver "psycopg[binary]"
python3 frontend-next/scripts/e2e_migrations.py
```

Run it whenever a migration is added or edited, and add the new file's
objects to `frontend-next/lib/schema-health.ts` (`TABLE_CHECKS`/`RPC_CHECKS`)
so `/api/health/db` covers them.
