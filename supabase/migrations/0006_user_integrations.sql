-- 0006_user_integrations.sql
-- Persists per-user integration enabled/disabled state for Settings → Integrations tab.
-- Run after 0005_production_fixes.sql in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.user_integrations (
  user_id        TEXT        NOT NULL,
  integration_id TEXT        NOT NULL,
  connected      BOOLEAN     NOT NULL DEFAULT false,
  connected_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, integration_id)
);

ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;

-- Idempotent re-runs: DROP IF EXISTS first (no CREATE POLICY IF NOT EXISTS).
DROP POLICY IF EXISTS "user_integrations: owner only" ON public.user_integrations;
CREATE POLICY "user_integrations: owner only"
  ON public.user_integrations FOR ALL
  USING  (user_id = auth.jwt() ->> 'sub')
  WITH CHECK (user_id = auth.jwt() ->> 'sub');

CREATE INDEX IF NOT EXISTS idx_user_integrations_user_id
  ON public.user_integrations (user_id);
