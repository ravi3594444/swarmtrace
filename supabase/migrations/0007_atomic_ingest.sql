-- 0007_atomic_ingest.sql
-- Fix: daily_metrics double-counting on SDK retries.
--
-- Bug: /api/ingest and /api/mcp call two separate RPCs — upsert_trace then
-- increment_daily_metrics. upsert_trace is idempotent (ON CONFLICT DO
-- UPDATE), but increment_daily_metrics unconditionally adds to the running
-- total. The SDK retries failed POSTs up to 3x with backoff. If the RPCs
-- succeed server-side but the HTTP response doesn't reach the client in
-- time (5s timeout stacked on two sequential REST calls from an edge
-- function — plausible under any Supabase cold start), the retry re-runs
-- both RPCs. upsert_trace no-ops, but increment_daily_metrics runs again
-- → cost/tokens double-counted on the dashboard.
--
-- Fix: fold both into ONE atomic function that only increments
-- daily_metrics when the trace was a FRESH INSERT (not a retry upsert).
-- Postgres idiom: after INSERT ... ON CONFLICT DO UPDATE, the system
-- column `xmax` is 0 for newly inserted rows and non-zero for rows that
-- were updated by the conflict clause. We RETURN (xmax = 0) to detect
-- this and gate the metrics increment on it.
--
-- This also cuts the ingest route from 2 round trips to 1.

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
  p_agent_name    TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_was_insert BOOLEAN;
BEGIN
  -- Upsert the trace. xmax = 0 on the returned row means it was a fresh
  -- INSERT (not an ON CONFLICT update). This is the standard Postgres
  -- idiom for detecting insert-vs-update in an upsert.
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
    agent_name    = EXCLUDED.agent_name
  RETURNING (xmax = 0) INTO v_was_insert;

  -- Only increment daily_metrics on a fresh insert — never on a retry
  -- upsert. This makes the whole operation idempotent: the SDK can retry
  -- safely and costs/tokens are counted exactly once.
  --
  -- Date is derived from p_timestamp (not CURRENT_DATE) so that traces
  -- queued offline and sent a day or two later land on the day they
  -- actually happened, not today. AT TIME ZONE 'UTC' extracts the UTC
  -- calendar date from the timestamptz, matching how the dashboard
  -- buckets days.
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

-- Keep the old functions for backwards compatibility (older deployed
-- code may still call them, and the MCP route will be updated separately).
-- They remain correct on their own; the double-count bug only manifests
-- when the caller invokes both in sequence AND retries.
