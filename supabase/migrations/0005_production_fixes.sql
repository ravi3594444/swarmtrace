-- 0005_production_fixes.sql
-- Fixes found in review:
--  1. add traces to the Realtime publication (live views were empty)
--  2. rebuild agent_events RLS on auth.jwt()->>'sub' instead of auth.uid(),
--     since user_id holds the Clerk user id
--  3. index api_keys(user_id)
--  4. upsert function for traces so retried ingests are idempotent
-- Browser Realtime also needs the Clerk and Supabase integration (see the end
-- of this file).

-- Fix 1: Add traces to Realtime publication
-- Guarded so re-running this file is safe (Postgres errors if the table is
-- already a member of the publication).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'traces'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.traces;
  END IF;
END $$;

-- Fix 2 + 3: Rebuild agent_events RLS policies
-- Drop the broken policy that used auth.uid() (Supabase UUID).
DROP POLICY IF EXISTS "users_own_events" ON public.agent_events;

-- New policy: uses auth.jwt()->>'sub' which carries the Clerk user ID when
-- the Clerk JWT template is configured (see setup note below).
-- DROP IF EXISTS makes this file safe to re-run.
DROP POLICY IF EXISTS "agent_events: owner only" ON public.agent_events;
CREATE POLICY "agent_events: owner only"
  ON public.agent_events
  FOR SELECT
  USING (user_id = auth.jwt() ->> 'sub');

-- Fix 4: Index on api_keys(user_id)
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id
  ON public.api_keys (user_id);

-- Fix 5: Upsert function for traces (idempotent ingest)
-- Called from /api/ingest instead of a plain INSERT. On duplicate (user_id, id)
-- the existing row is updated in place, making retries safe.
CREATE OR REPLACE FUNCTION public.upsert_trace(
  p_id            TEXT,
  p_user_id       TEXT,
  p_parent_id     TEXT,
  p_function      TEXT,
  p_args          TEXT,
  p_output        TEXT,
  p_latency_sec   DOUBLE PRECISION,
  p_error         TEXT,
  p_timestamp     TIMESTAMPTZ,
  p_input_tokens  INTEGER,
  p_output_tokens INTEGER,
  p_cost_usd      DOUBLE PRECISION,
  p_kind          TEXT,
  p_agent_id      TEXT,
  p_agent_name    TEXT
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.traces (
    id, user_id, parent_id, function, args, output,
    latency_sec, error, timestamp,
    input_tokens, output_tokens, cost_usd,
    kind, agent_id, agent_name
  ) VALUES (
    p_id, p_user_id, p_parent_id, p_function, p_args, p_output,
    p_latency_sec, p_error, p_timestamp,
    p_input_tokens, p_output_tokens, p_cost_usd,
    p_kind, p_agent_id, p_agent_name
  )
  ON CONFLICT (user_id, id) DO UPDATE SET
    output        = EXCLUDED.output,
    latency_sec   = EXCLUDED.latency_sec,
    error         = EXCLUDED.error,
    input_tokens  = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cost_usd      = EXCLUDED.cost_usd,
    kind          = EXCLUDED.kind,
    agent_id      = EXCLUDED.agent_id,
    agent_name    = EXCLUDED.agent_name;
END;
$$;

-- Required, and not possible via SQL: the native Clerk and Supabase integration.
-- Without it, browser Realtime subscriptions receive no events. Don't use the
-- legacy JWT template method, which shares Supabase's JWT secret with Clerk.
--
-- 1. Clerk Dashboard: Integrations, Supabase, Configure; copy the Clerk domain
--    (like https://your-app.clerk.accounts.dev).
-- 2. Supabase Dashboard: Authentication, Providers, Clerk; enable it and paste
--    the domain.
--
-- Supabase then validates Clerk tokens through Clerk's public JWKS endpoint.
-- The code (RealtimeContext.tsx) calls getToken() with no template param , 
-- the standard Clerk session token is accepted directly by Supabase once
-- the native integration is enabled.
--
