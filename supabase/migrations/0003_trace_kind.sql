-- 0003_trace_kind.sql
-- Adds span classification (kind, agent_id, agent_name) so the dashboard doesn't
-- have to guess which traces are agents.
-- Existing rows get kind='agent', agent_id=id, agent_name=function, which keeps
-- the old one-agent-per-trace behavior.

ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS kind       TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS agent_id   TEXT;
ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS agent_name TEXT;

-- Backfill so agent_id/agent_name are never null for pre-existing rows,
-- without changing what those rows mean.
UPDATE public.traces
SET agent_id = id, agent_name = function
WHERE agent_id IS NULL;

-- /api/agents groups everything by agent_id (and looks for the kind='agent'
-- row whose id == agent_id), this index keeps that cheap per-user.
CREATE INDEX IF NOT EXISTS idx_traces_user_agent ON public.traces (user_id, agent_id);
