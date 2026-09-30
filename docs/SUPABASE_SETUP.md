# Dashboard backend setup (Supabase and Vercel)

How to deploy the SwarmTrace dashboard yourself, or fix a deployment where traces
never show up.

The usual failure: the dashboard loads, you created an API key, your SDK logs
`remote ingest failed after 3 attempts: HTTP Error 500`, and nothing appears. This
almost always means the Supabase migrations were never applied (step 2).

## 1. Create the projects

1. Supabase: create a project at [supabase.com](https://supabase.com). Note the
   project URL (`https://<ref>.supabase.co`) and, under Project Settings, API, the
   `anon` and `service_role` keys. Keep the service key server-side.
2. Clerk: create an application at [clerk.com](https://clerk.com) for sign-in and
   note the `pk_...` and `sk_...` keys.

## 2. Apply the database migrations

The tables, RLS policies and the `upsert_trace_for_key` RPC used by `/api/ingest`
come from the SQL files in [`supabase/migrations/`](../supabase/migrations/). Apply
them in filename order.

### Option A: the runner

```bash
cd frontend-next
# Supabase Dashboard > Project Settings > Database > Connection string (URI)
export SUPABASE_DB_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres"

npm run db:migrate    # applies pending migrations, records them in public.schema_migrations
npm run db:status     # applied vs pending
```

Run `node scripts/run-migrations.mjs --help` for all modes.

- It needs `psql` on your PATH (`brew install libpq` or `apt install postgresql-client`).
- If you are on an IPv4-only network and the direct host (port 5432) won't connect,
  use the session pooler host (`...pooler.supabase.com:5432`) from the same page.
- Re-running is safe. Each migration runs in one transaction and applied ones are
  skipped.

### Option B: the Supabase SQL editor

```bash
cd frontend-next
node scripts/run-migrations.mjs --print --all   # all migrations as one script
```

Paste the output into the SQL editor and run it. The migrations are idempotent, so
running them on a partly migrated project brings it up to date.

## 3. Set environment variables

Set these in Vercel (Project, Environment Variables) and in
`frontend-next/.env.local` for local development. See
[`.env.example`](../frontend-next/.env.example).

| Variable | Source |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk, API Keys |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase, API (service_role key) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase, API (anon key) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | [console.upstash.com](https://console.upstash.com); required in production for rate limits |
| `SUPABASE_DB_URL` | Supabase, Database; only used by the migration runner |

Redeploy after changing them.

## 4. Check the schema

```bash
curl https://<your-dashboard>/api/health/db
```

- `200 {"ok":true,...}`: schema complete and RPC signatures current.
- `503 {"ok":false,"missingMigrations":[...],"hint":...}`: lists the migrations to
  apply. Apply them and check again.
- `503 {"error":"not_configured"}`: `SUPABASE_URL` or `SUPABASE_SERVICE_KEY` is not
  set on the deployment.

The endpoint is public, read-only, never reads user data, and is rate limited per
IP. It calls each SECURITY DEFINER RPC with a fake key hash. The function rejects
it with `invalid_api_key` after matching the signature, so the check writes nothing.

## 5. Create an API key and send a trace

1. Sign in to the dashboard and go to Settings, API Keys, Create. The Hobby plan
   allows one key.
2. Point the SDK at it:
   ```python
   from swarmtrace import init, observe
   init(api_key="st_...", endpoint="https://<your-dashboard>")
   ```
3. Run your agent. Traces arrive within a couple of seconds. If delivery fails,
   rows stay in `~/.swarmtrace.db` and `swarmtrace-resync` replays them.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `HTTP Error 500` with `SCHEMA_NOT_MIGRATED` in SDK logs | Migrations missing or behind | Step 2, then `/api/health/db` |
| `HTTP Error 401` with `Invalid or revoked API key` | Wrong key, or key revoked | Create a new key in Settings, API Keys |
| `HTTP Error 429` | Rate limited (120 ingests/min per key) | Back off and resync later |
| Dashboard pages all return 401 | Clerk and Supabase integration not set up | See the header comment in migration 0005; check `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Dashboard empty but ingest succeeds | Traces are under a different user or project, or Realtime isn't streaming | Check `/api/traces` in your session and the Clerk integration; hard-refresh |
| `not_configured` from `/api/health/db` | Env vars missing on Vercel | Step 3, then redeploy |

## Hardening the legacy ingest RPCs (older projects)

Migration `0012` does this automatically when you run `db:migrate`. The manual
script below is only for projects that can't run it.

Migrations 0010 and 0011 revoke `PUBLIC`, `anon` and `authenticated` on the
`*_for_key` RPCs. That is needed because a project-level
`ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS` gives those roles a
direct grant on new functions, and `REVOKE ... FROM PUBLIC` does not remove it.

The older RPCs (`upsert_trace_with_metrics`, `upsert_trace`,
`increment_daily_metrics`) predate this. They accept a caller-chosen `user_id`, so
if `anon` or `authenticated` can call them, anyone with your anon key could write
traces under any tenant through PostgREST. No app code calls them, so revoking is
safe. Run this in the SQL editor (it is idempotent and works for any signature):

```sql
DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('upsert_trace_with_metrics', 'upsert_trace',
                        'increment_daily_metrics')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;
```

## Testing migration changes

`frontend-next/scripts/e2e_migrations.py` migrates a fresh local Postgres (using the
`pgserver` package, no Docker), re-applies every file raw, and calls
`upsert_trace_for_key` the way `/api/ingest` does:

```bash
pip install pgserver "psycopg[binary]"
python3 frontend-next/scripts/e2e_migrations.py
```

Run it whenever you add or edit a migration, and add the new objects to
`frontend-next/lib/schema-health.ts` (`TABLE_CHECKS` / `RPC_CHECKS`) so
`/api/health/db` covers them.
