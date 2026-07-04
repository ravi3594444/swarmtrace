-- 0005_production_fixes.sql
-- Critical fixes identified in production audit. Run after 0004_agent_events.sql.
--
-- Issues fixed:
--
-- 1. traces NOT in Realtime publication
--    The overview page and traces/live mode both subscribe to postgres_changes
--    on the traces table, but traces was never added to supabase_realtime.
--    Result: ALL live events on Overview and Traces pages are silently empty.
--
-- 2. agent_events RLS uses auth.uid() (Supabase UUID) not auth.jwt()->>'sub'
--    (Clerk user ID). The system stores Clerk user IDs in user_id. auth.uid()
--    returns a Supabase UUID which never matches — so the users_own_events
--    policy effectively blocks every authenticated user from their own events.
--    Fixed to use auth.jwt()->>'sub' consistently with every other table.
--
-- 3. Browser Realtime requires Clerk JWT integration
--    The browser Supabase client uses the anon key. Without a Clerk JWT
--    template configured, auth.jwt() returns null and all RLS policies that
--    check user_id block Realtime events. This migration adds the correct
--    policies; the Clerk dashboard setup is documented below.
--
-- 4. No index on api_keys(user_id)
--    GET /api/settings/api-keys queries api_keys by user_id on every page
--    load. Without an index this is a full table scan that worsens with
--    every user added.
--
-- 5. traces table allows duplicate inserts (no upsert semantics)
--    The ingest route does a plain POST. On network retry, the same trace_id
--    arrives twice and Postgres returns a 409 unique violation which the
--    ingest route converts to a 500. Fixed with an ON CONFLICT DO UPDATE
--    (upsert) trigger function so retries are idempotent.

-- ── Fix 1: Add traces to Realtime publication ─────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.traces;

-- ── Fix 2 + 3: Rebuild agent_events RLS policies ─────────────────────────────
-- Drop the broken policy that used auth.uid() (Supabase UUID).
DROP POLICY IF EXISTS "users_own_events" ON public.agent_events;

-- New policy: uses auth.jwt()->>'sub' which carries the Clerk user ID when
-- the Clerk JWT template is configured (see setup note below).
CREATE POLICY "agent_events: owner only"
  ON public.agent_events
  FOR SELECT
  USING (user_id = auth.jwt() ->> 'sub');

-- ── Fix 4: Index on api_keys(user_id) ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id
  ON public.api_keys (user_id);

-- ── Fix 5: Upsert function for traces (idempotent ingest) ────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- REQUIRED: Native Clerk + Supabase integration (cannot be done via SQL)
-- Without this, all browser Realtime subscriptions are silent (no events).
--
-- ⚠️  DO NOT use the legacy "JWT Template" method — it shares Supabase's
-- master JWT secret with Clerk, which is a security risk and causes downtime
-- on secret rotation. Both Clerk and Supabase have deprecated it.
--
-- Modern approach (uses Clerk's public JWKS — no shared secrets):
--
-- Step 1 — Clerk Dashboard (https://dashboard.clerk.com):
--   1. Go to Integrations (or Configure → Integrations)
--   2. Find the Supabase integration card and click Configure
--   3. Copy your Clerk Domain
--      (looks like: https://your-app.clerk.accounts.dev)
--
-- Step 2 — Supabase Dashboard (https://supabase.com/dashboard):
--   1. Go to Authentication → Providers (or Sign In → Providers)
--   2. Find "Clerk" in the provider list
--   3. Toggle it ON
--   4. Paste your Clerk Domain from Step 1
--   5. Save
--
-- That's it. Supabase will now validate Clerk tokens via Clerk's public
-- JWKS endpoint automatically. No secrets change hands.
--
-- The code (RealtimeContext.tsx) calls getToken() with no template param —
-- the standard Clerk session token is accepted directly by Supabase once
-- the native integration is enabled.
-- ─────────────────────────────────────────────────────────────────────────────
