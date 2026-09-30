-- 0012_rls_initplan_and_legacy_rpc_hardening.sql
-- 1. Wrap auth.jwt() in (SELECT ...) in every owner-only RLS policy so Postgres
--    evaluates it once per query instead of once per row (an InitPlan).
--    Same predicate and semantics.
-- 2. Revoke the legacy upsert_trace, upsert_trace_with_metrics and
--    increment_daily_metrics RPCs from PUBLIC/anon/authenticated and pin
--    search_path. They accept a caller-chosen user_id and no app code calls
--    them. This is the script docs/SUPABASE_SETUP.md describes.
-- Idempotent: DROP POLICY IF EXISTS plus a signature-agnostic DO block.

-- Legacy RPC grants + search_path
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

-- RLS initplan fix: api_keys, traces, daily_metrics, agent_events,
-- user_integrations, regression_runs
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
