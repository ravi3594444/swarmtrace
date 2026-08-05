-- 0010_tenant_isolation_ingest.sql
-- High: multi-tenant isolation must not depend only on app-layer filters when
-- the service-role key is used for ingest/events/mcp.
--
-- Background
-- ----------
-- Dashboard reads already go through supaUserRequest() which passes the Clerk
-- JWT and lets Postgres RLS (user_id = auth.jwt()->>'sub') enforce isolation.
-- Ingest, FOV events, and MCP still authenticate with an API key and then
-- write via the service-role key, which BYPASSES RLS. Isolation on those
-- paths is currently "the app looked up key_hash → user_id and stuffed that
-- user_id into the RPC". A future route bug (or a compromised service key
-- used from a misconfigured client) can write under any user_id.
--
-- Fix
-- ---
-- 1. resolve_api_key_user_id(p_key_hash) — SECURITY DEFINER helper.
-- 2. upsert_trace_for_key(...) — same as upsert_trace_with_metrics but takes
--    p_key_hash instead of p_user_id. The function stamps user_id itself.
-- 3. insert_agent_event_for_key(...) — same pattern for FOV events.
-- 4. REVOKE EXECUTE from PUBLIC/anon/authenticated; GRANT only to service_role.
--
-- The legacy upsert_trace_with_metrics(p_user_id, ...) signature is left in
-- place for integration tests and older deploy rollbacks, but application
-- code MUST call the *_for_key variants so tenant identity is bound to the
-- API key inside Postgres.

CREATE OR REPLACE FUNCTION public.resolve_api_key_user_id(p_key_hash TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  IF p_key_hash IS NULL OR length(p_key_hash) < 32 THEN
    RAISE EXCEPTION 'invalid_api_key' USING ERRCODE = '28000';
  END IF;

  SELECT user_id INTO v_user_id
  FROM public.api_keys
  WHERE key_hash = p_key_hash
    AND revoked = false
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_api_key' USING ERRCODE = '28000';
  END IF;

  RETURN v_user_id;
END;
$$;

-- anon/authenticated are revoked EXPLICITLY (not just PUBLIC): on Supabase
-- projects whose default privileges (ALTER DEFAULT PRIVILEGES ... GRANT
-- EXECUTE ON FUNCTIONS) hand them a DIRECT grant on newly created functions,
-- a PUBLIC revoke alone leaves that direct grant in place.
REVOKE ALL ON FUNCTION public.resolve_api_key_user_id(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_api_key_user_id(TEXT) TO service_role;

-- ── Ingest: key-hash-scoped upsert ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_trace_for_key(
  p_key_hash      TEXT,
  p_id            TEXT,
  p_parent_id     TEXT DEFAULT NULL,
  p_function      TEXT DEFAULT '',
  p_args          TEXT DEFAULT '',
  p_output        TEXT DEFAULT '',
  p_latency_sec   DOUBLE PRECISION DEFAULT 0,
  p_error         TEXT DEFAULT NULL,
  p_timestamp     TIMESTAMPTZ DEFAULT now(),
  p_input_tokens  INTEGER DEFAULT 0,
  p_output_tokens INTEGER DEFAULT 0,
  p_cost_usd      DOUBLE PRECISION DEFAULT 0,
  p_kind          TEXT DEFAULT 'agent',
  p_agent_id      TEXT DEFAULT NULL,
  p_agent_name    TEXT DEFAULT NULL,
  p_session_id    TEXT DEFAULT NULL,
  p_trace_id      TEXT DEFAULT NULL,
  p_attributes    JSONB DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    TEXT;
  v_was_insert BOOLEAN;
  v_trace_id   TEXT;
BEGIN
  v_user_id  := public.resolve_api_key_user_id(p_key_hash);
  v_trace_id := COALESCE(NULLIF(p_trace_id, ''), p_id);

  INSERT INTO public.traces (
    id, user_id, parent_id, trace_id, function, args, output,
    latency_sec, error, timestamp,
    input_tokens, output_tokens, cost_usd,
    kind, agent_id, agent_name, session_id, attributes
  ) VALUES (
    p_id, v_user_id, p_parent_id, v_trace_id, p_function,
    COALESCE(p_args, ''), COALESCE(p_output, ''),
    p_latency_sec, p_error, p_timestamp,
    COALESCE(p_input_tokens, 0), COALESCE(p_output_tokens, 0), COALESCE(p_cost_usd, 0),
    p_kind, p_agent_id, p_agent_name, p_session_id, p_attributes
  )
  ON CONFLICT (user_id, id) DO UPDATE SET
    trace_id      = COALESCE(EXCLUDED.trace_id, public.traces.trace_id),
    output        = EXCLUDED.output,
    latency_sec   = EXCLUDED.latency_sec,
    error         = EXCLUDED.error,
    input_tokens  = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cost_usd      = EXCLUDED.cost_usd,
    kind          = EXCLUDED.kind,
    agent_id      = EXCLUDED.agent_id,
    agent_name    = EXCLUDED.agent_name,
    session_id    = COALESCE(EXCLUDED.session_id, public.traces.session_id),
    attributes    = COALESCE(EXCLUDED.attributes, public.traces.attributes)
  RETURNING (xmax = 0) INTO v_was_insert;

  IF v_was_insert THEN
    INSERT INTO public.daily_metrics (user_id, date, cost_usd, input_tokens, output_tokens, trace_count)
    VALUES (
      v_user_id,
      DATE(p_timestamp AT TIME ZONE 'UTC'),
      COALESCE(p_cost_usd, 0),
      COALESCE(p_input_tokens, 0),
      COALESCE(p_output_tokens, 0),
      1
    )
    ON CONFLICT (user_id, date) DO UPDATE SET
      cost_usd      = daily_metrics.cost_usd      + EXCLUDED.cost_usd,
      input_tokens  = daily_metrics.input_tokens  + EXCLUDED.input_tokens,
      output_tokens = daily_metrics.output_tokens + EXCLUDED.output_tokens,
      trace_count   = daily_metrics.trace_count   + 1;
  END IF;

  UPDATE public.api_keys
     SET last_used = now()
   WHERE key_hash = p_key_hash
     AND revoked = false;

  RETURN v_was_insert;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_trace_for_key(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT, TIMESTAMPTZ,
  INTEGER, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_trace_for_key(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT, TIMESTAMPTZ,
  INTEGER, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

-- ── FOV events: key-hash-scoped insert ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insert_agent_event_for_key(
  p_key_hash   TEXT,
  p_id         TEXT,
  p_agent_id   TEXT,
  p_event_type TEXT,
  p_status     TEXT DEFAULT 'info',
  p_agent_name TEXT DEFAULT NULL,
  p_data       JSONB DEFAULT NULL,
  p_timestamp  TIMESTAMPTZ DEFAULT now()
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  v_user_id := public.resolve_api_key_user_id(p_key_hash);

  INSERT INTO public.agent_events (
    id, user_id, agent_id, agent_name, event_type, status, data, timestamp
  ) VALUES (
    p_id, v_user_id, p_agent_id, p_agent_name, p_event_type,
    COALESCE(p_status, 'info'), p_data, COALESCE(p_timestamp, now())
  );

  UPDATE public.api_keys
     SET last_used = now()
   WHERE key_hash = p_key_hash
     AND revoked = false;

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_agent_event_for_key(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_agent_event_for_key(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) TO service_role;
