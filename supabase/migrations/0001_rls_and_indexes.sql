-- 0001_rls_and_indexes.sql
-- Run against the Supabase project (SQL editor or `supabase db push`).

-- Tenant isolation: enable Row Level Security. The dashboard and ingest API
-- currently use the service-role key (which bypasses RLS), so these policies
-- are defense-in-depth today and become fully enforced once per-user JWTs
-- (Clerk <-> Supabase integration) replace the service key.
alter table public.api_keys enable row level security;
alter table public.traces enable row level security;

-- Idempotent: DROP IF EXISTS before CREATE so this file can be re-run
-- safely (Postgres has no CREATE POLICY IF NOT EXISTS).
drop policy if exists "api_keys: owner only" on public.api_keys;
create policy "api_keys: owner only"
  on public.api_keys for all
  using (user_id = auth.jwt() ->> 'sub')
  with check (user_id = auth.jwt() ->> 'sub');

drop policy if exists "traces: owner only" on public.traces;
create policy "traces: owner only"
  on public.traces for all
  using (user_id = auth.jwt() ->> 'sub')
  with check (user_id = auth.jwt() ->> 'sub');

-- Integrity + performance
create unique index if not exists idx_api_keys_key_hash on public.api_keys (key_hash);
create index if not exists idx_traces_user_ts on public.traces (user_id, timestamp desc);

-- Suggested retention job (uncomment and adjust if pg_cron is enabled):
-- select cron.schedule('trim-traces', '0 3 * * *',
--   $$delete from public.traces where timestamp < now() - interval '90 days'$$);
