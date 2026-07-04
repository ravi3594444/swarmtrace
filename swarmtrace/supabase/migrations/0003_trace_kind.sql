-- 0003_trace_kind.sql
-- Adds explicit span classification so the dashboard no longer has to GUESS
-- which traces are "agents" vs. function/tool/LLM calls made BY an agent.
-- Run after 0002_daily_metrics.sql in the Supabase SQL editor.
--
-- WHY: previously every @observe'd call was an indistinguishable row, so the
-- Agents page either treated every unique `function` as its own "agent"
-- (including raw sub-calls like llm/gemini-3.1-flash-lite or
-- tool/skill_manage), or had to reconstruct agent boundaries by walking
-- parent_id chains client-side — fragile when traces arrive flat or out of
-- order. tracely >= 0.3.0 now stamps this at the source on every span:
--
--   kind        'agent' | 'tool' | 'llm' | 'function'
--   agent_id    id of the @observe(kind="agent") span this trace belongs to
--   agent_name  that agent's function name (denormalized for cheap grouping)
--
-- Existing rows (written by older SDK versions, or by /api/ingest before a
-- client upgrades) get kind='agent', agent_id=id, agent_name=function — i.e.
-- exactly today's per-trace-is-its-own-agent behavior, so nothing regresses.
-- New rows from tracely >= 0.3.0 carry real values and roll up correctly.

ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS kind       TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS agent_id   TEXT;
ALTER TABLE public.traces ADD COLUMN IF NOT EXISTS agent_name TEXT;

-- Backfill so agent_id/agent_name are never null for pre-existing rows,
-- without changing what those rows mean.
UPDATE public.traces
SET agent_id = id, agent_name = function
WHERE agent_id IS NULL;

-- /api/agents groups everything by agent_id (and looks for the kind='agent'
-- row whose id == agent_id) — this index keeps that cheap per-user.
CREATE INDEX IF NOT EXISTS idx_traces_user_agent ON public.traces (user_id, agent_id);
