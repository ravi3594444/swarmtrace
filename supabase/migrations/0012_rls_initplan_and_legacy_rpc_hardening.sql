-- 0012_rls_initplan_and_legacy_rpc_hardening.sql
-- Two independent hardening fixes surfaced by Supabase's advisor lints.
--
-- 1. RLS initplan performance (WARN, category PERFORMANCE)
--    -------------------------------------------------------
--    Every "owner only" RLS policy compared user_id against a bare
--    auth.jwt() call, which Postgres re-evaluates once per row scanned
--    instead of once per query. Wrapping the call in a scalar subquery
--    (SELECT auth.jwt() ->> 'sub') lets the planner treat it as an
--    InitPlan — evaluated once — which is the standard fix documented at
--    https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--    Same predicate, same semantics, no application-visible change.
--
-- 2. Legacy RPC grants + mutable search_path (WARN, category SECURITY)
--    -------------------------------------------------------------------
--    This is the exact hardening docs/SUPABASE_SETUP.md's "Hardening:
--    legacy ingest RPCs (older projects)" section has instructed operators
--    to paste into the SQL editor since migration 0010 shipped, formalized
--    here so a fresh `db:migrate` run closes the gap automatically instead
--    of depending on a manual step. upsert_trace / upsert_trace_with_metrics
--    / increment_daily_metrics pre-date the *_for_key RPCs, accept a
--    caller-chosen user_id, and are superseded — no app code calls them.
--    Confirmed via query: nothing else in this codebase references them
--    outside supabase/migrations/ and this doc.
--
-- Idempotent: DROP POLICY IF EXISTS guards + a signature-agnostic DO block
-- for the REVOKE/GRANT/search_path pass (matches the pattern already used
-- for 0010/0011's tenant-isolation RPCs). Safe to re-run.

-- ── Legacy RPC grants + search_path ─────────────────────────────────────
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
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', f.sig);
  END LOOP;
END $$;

-- ── RLS initplan fix: api_keys, traces, daily_metrics, agent_events, ───
-- ── user_integrations, regression_runs ──────────────────────────────────
DROP POLICY IF EXISTS "api_keys: owner only" ON public.api_keys;
CREATE POLICY "api_keys: owner only" ON public.api_keys
    FOR ALL
    USING (user_id = (SELECT auth.jwt() ->> 'sub'))
    WITH CHECK (user_id = (SELECT auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "traces: owner only" ON public.traces;
CREATE POLICY "traces: owner only" ON public.traces
    FOR ALL
    USING (user_id = (SELECT auth.jwt() ->> 'sub'))
    WITH CHECK (user_id = (SELECT auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "daily_metrics: owner only" ON public.daily_metrics;
CREATE POLICY "daily_metrics: owner only" ON public.daily_metrics
    FOR ALL
    USING (user_id = (SELECT auth.jwt() ->> 'sub'))
    WITH CHECK (user_id = (SELECT auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "agent_events: owner only" ON public.agent_events;
CREATE POLICY "agent_events: owner only" ON public.agent_events
    FOR SELECT
    USING (user_id = (SELECT auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "user_integrations: owner only" ON public.user_integrations;
CREATE POLICY "user_integrations: owner only" ON public.user_integrations
    FOR ALL
    USING (user_id = (SELECT auth.jwt() ->> 'sub'))
    WITH CHECK (user_id = (SELECT auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS "regression_runs_select_own" ON public.regression_runs;
CREATE POLICY "regression_runs_select_own" ON public.regression_runs
    FOR SELECT
    USING (user_id = (SELECT auth.jwt() ->> 'sub'));
