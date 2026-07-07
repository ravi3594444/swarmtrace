-- 0008_session_id.sql
-- Feature: conversation / session grouping ("threads").
--
-- Multi-turn chat agents span many @observe calls (one per user turn). Until
-- now each call — or nested tree — stood alone, so there was no way to view
-- "this user's whole conversation across N messages" as one unit. This adds
-- an optional session_id that the SDK/ingest can set to stitch turns together
-- (the SwarmTrace analogue of LangSmith "threads").
--
-- Fully backward-compatible:
--   * session_id is nullable — older SDKs that never send it keep working and
--     simply show up as ungrouped, single-turn runs.
--   * The upsert RPC gains p_session_id with a DEFAULT so existing callers
--     (e.g. the MCP route) that don't pass it are unaffected.

ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Index for the Threads view: list a user's sessions newest-first and pull all
-- turns for one session in timestamp order.
CREATE INDEX IF NOT EXISTS idx_traces_session
  ON public.traces (user_id, session_id, timestamp)
  WHERE session_id IS NOT NULL;

-- Recreate the atomic ingest function with an optional p_session_id.
-- Adding a parameter changes the function signature, so the old definition is
-- dropped first. p_session_id defaults to NULL so callers that omit it (the
-- MCP route, older deployed code) continue to work unchanged.
DROP FUNCTION IF EXISTS public.upsert_trace_with_metrics(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT, TIMESTAMPTZ,
  INTEGER, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION public.upsert_trace_with_metrics(
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
  p_agent_name    TEXT,
  p_session_id    TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_was_insert BOOLEAN;
BEGIN
  INSERT INTO public.traces (
    id, user_id, parent_id, function, args, output,
    latency_sec, error, timestamp,
    input_tokens, output_tokens, cost_usd,
    kind, agent_id, agent_name, session_id
  ) VALUES (
    p_id, p_user_id, p_parent_id, p_function, p_args, p_output,
    p_latency_sec, p_error, p_timestamp,
    p_input_tokens, p_output_tokens, p_cost_usd,
    p_kind, p_agent_id, p_agent_name, p_session_id
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
    agent_name    = EXCLUDED.agent_name,
    session_id    = COALESCE(EXCLUDED.session_id, public.traces.session_id)
  RETURNING (xmax = 0) INTO v_was_insert;

  IF v_was_insert THEN
    INSERT INTO public.daily_metrics (user_id, date, cost_usd, input_tokens, output_tokens, trace_count)
    VALUES (p_user_id, DATE(p_timestamp AT TIME ZONE 'UTC'), p_cost_usd, p_input_tokens, p_output_tokens, 1)
    ON CONFLICT (user_id, date) DO UPDATE SET
      cost_usd      = daily_metrics.cost_usd      + EXCLUDED.cost_usd,
      input_tokens  = daily_metrics.input_tokens  + EXCLUDED.input_tokens,
      output_tokens = daily_metrics.output_tokens + EXCLUDED.output_tokens,
      trace_count   = daily_metrics.trace_count   + 1;
  END IF;

  RETURN v_was_insert;
END;
$$;
