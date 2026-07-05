-- Migration: 0004_agent_events.sql
-- Adds the agent_events table used by SwarmTrace FOV (live agent activity).
-- Realtime is enabled so the dashboard receives events via WebSocket
-- without any polling or Vercel serverless involvement.

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_events (
  id           TEXT        PRIMARY KEY,
  user_id      TEXT        NOT NULL,
  agent_id     TEXT        NOT NULL,
  agent_name   TEXT,
  event_type   TEXT        NOT NULL,   -- 'browser' | 'llm_token' | 'http' | 'file'
  status       TEXT        NOT NULL DEFAULT 'info',  -- 'started'|'done'|'error'|'streaming'|'info'
  data         JSONB,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_events_user_agent
  ON agent_events (user_id, agent_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_agent_events_type
  ON agent_events (user_id, event_type, timestamp DESC);

-- ── Row-level security ────────────────────────────────────────────────────────
ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;

-- Service role (used by the ingest API route) can insert/select freely.
-- Authenticated users can only see their own events.
CREATE POLICY "service_full_access" ON agent_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "users_own_events" ON agent_events
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()::text));

-- ── Realtime ─────────────────────────────────────────────────────────────────
-- This is the key line: the browser subscribes directly to this publication
-- via Supabase Realtime WebSocket.  Vercel is NOT in the real-time path.
ALTER PUBLICATION supabase_realtime ADD TABLE agent_events;

-- ── Auto-purge old events (keep last 7 days per user) ─────────────────────────
-- Run this as a cron job (Supabase pg_cron or external):
--   SELECT cron.schedule('purge-fov-events', '0 * * * *',
--     $$DELETE FROM agent_events WHERE timestamp < NOW() - INTERVAL '7 days'$$);
