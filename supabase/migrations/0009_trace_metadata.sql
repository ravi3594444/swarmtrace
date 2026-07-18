-- 0009_trace_metadata.sql
-- Feature: generic trace metadata and distributed trace context.
--
-- Adds trace_id (the distributed root run id) and attributes (generic JSON
-- metadata) to the traces table. Existing rows are backfilled so that each
-- becomes its own trace until cross-span context is available, matching the
-- Python SDK behavior.
--
-- Backwards-compatible:
--   * Both columns are nullable.
--   * The upsert RPC gains p_trace_id and p_attributes with DEFAULTs so
--     existing callers (MCP route, older SDK) are unaffected.

ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS attributes JSONB;

-- Backfill: every existing row is its own trace until the SDK sends real trace_id.
UPDATE public.traces SET trace_id = id WHERE trace_id IS NULL;

-- Index for run-history and timeline queries: find all spans of a trace quickly.
CREATE INDEX IF NOT EXISTS idx_traces_trace_id
  ON public.traces (user_id, trace_id, timestamp);

-- Drop the old signature(s) before recreating the function with new parameters.
DROP FUNCTION IF EXISTS public.upsert_trace_with_metrics(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT, TIMESTAMPTZ,
  INTEGER, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT
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
  p_session_id    TEXT DEFAULT NULL,
  p_trace_id      TEXT DEFAULT NULL,
  p_attributes    JSONB DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_was_insert BOOLEAN;
BEGIN
  INSERT INTO public.traces (
    id, user_id, parent_id, trace_id, function, args, output,
    latency_sec, error, timestamp,
    input_tokens, output_tokens, cost_usd,
    kind, agent_id, agent_name, session_id, attributes
  ) VALUES (
    p_id, p_user_id, p_parent_id, COALESCE(p_trace_id, p_id), p_function, p_args, p_output,
    p_latency_sec, p_error, p_timestamp,
    p_input_tokens, p_output_tokens, p_cost_usd,
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
