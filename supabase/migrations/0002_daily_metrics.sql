-- 0002_daily_metrics.sql
-- Pre-aggregated per-user daily metrics table.
-- Run after 0001_rls_and_indexes.sql in the Supabase SQL editor.
--
-- WHY: /api/metrics must NOT scan the traces table on every page load.
-- Instead: ingest → atomically increments this table (one row per user per day).
--          /api/metrics reads max 90 rows. Fast, cheap, live-friendly.

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_metrics (
  user_id       TEXT    NOT NULL,
  date          DATE    NOT NULL DEFAULT CURRENT_DATE,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  trace_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- ── Atomic upsert function (called from the ingest edge function) ─────────────
-- Uses ON CONFLICT to atomically increment without a read-modify-write race.
CREATE OR REPLACE FUNCTION public.increment_daily_metrics(
  p_user_id       TEXT,
  p_cost          REAL,
  p_input_tokens  INTEGER,
  p_output_tokens INTEGER
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.daily_metrics (user_id, date, cost_usd, input_tokens, output_tokens, trace_count)
  VALUES (p_user_id, CURRENT_DATE, p_cost, p_input_tokens, p_output_tokens, 1)
  ON CONFLICT (user_id, date) DO UPDATE SET
    cost_usd      = daily_metrics.cost_usd      + EXCLUDED.cost_usd,
    input_tokens  = daily_metrics.input_tokens  + EXCLUDED.input_tokens,
    output_tokens = daily_metrics.output_tokens + EXCLUDED.output_tokens,
    trace_count   = daily_metrics.trace_count   + 1;
END;
$$;

-- ── RLS: same tenant-isolation pattern as traces / api_keys ──────────────────
ALTER TABLE public.daily_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_metrics: owner only"
  ON public.daily_metrics FOR ALL
  USING  (user_id = auth.jwt() ->> 'sub')
  WITH CHECK (user_id = auth.jwt() ->> 'sub');

-- ── Performance index for the metrics API query (user_id + date DESC) ────────
CREATE INDEX IF NOT EXISTS idx_daily_metrics_user_date
  ON public.daily_metrics (user_id, date DESC);

-- ── Supabase Realtime: fire INSERT/UPDATE events to subscribed clients ────────
-- Required for the visibility-aware live dashboard.
ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_metrics;
