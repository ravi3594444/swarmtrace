/**
 * Resolves (kind, agent_id, agent_name) for an incoming MCP record_trace
 * call.
 *
 * Extracted out of app/api/mcp/route.ts so this logic — the exact fix for
 * the "kind is hardcoded on the MCP path" audit finding — can be unit
 * tested directly (see scripts/test-resolve-trace-identity.mjs) instead of
 * only being exercised indirectly through a full MCP tool-call round trip
 * against a live Supabase connection.
 *
 * BEFORE this fix: kind was hardcoded to 'agent' and agent_id was hardcoded
 * to params.id (fresh per call) — every MCP trace got tagged 'agent'
 * regardless of what it actually was, and every call became its own
 * dashboard card instead of aggregating. The Python SDK properly
 * distinguishes agent/tool/llm/function via @observe(kind=...); MCP
 * couldn't distinguish anything.
 *
 * AFTER: kind comes from the caller (default 'agent'). Because MCP calls
 * are stateless — there's no contextvar the way the Python SDK's
 * @observe has to infer "which agent is this nested call under" — agent_id
 * is REQUIRED whenever kind isn't 'agent'. When kind IS 'agent', agent_id
 * still defaults to a stable SHA-256 of `function` so repeat calls
 * aggregate into one dashboard card, matching bare @observe behavior.
 */
import { stableAgentId } from './stable-agent-id'

export type TraceKind = 'agent' | 'tool' | 'llm' | 'function' | 'retrieval'

export interface ResolveTraceIdentityInput {
  kind?: TraceKind
  agent_id?: string
  agent_name?: string
  function: string
}

export type ResolveTraceIdentityResult =
  | { ok: true; kind: TraceKind; agentId: string; agentName: string }
  | { ok: false; error: string }

export function resolveTraceIdentity(
  input: ResolveTraceIdentityInput
): ResolveTraceIdentityResult {
  const kind = input.kind ?? 'agent'

  if (kind !== 'agent' && !input.agent_id) {
    return {
      ok: false,
      error:
        `agent_id is required when kind is "${kind}" — MCP calls are ` +
        `stateless, so there is no enclosing-agent context to infer it ` +
        `from. Pass the agent_id of the enclosing agent span.`,
    }
  }

  const agentId =
    kind === 'agent' ? input.agent_id ?? stableAgentId(input.function) : input.agent_id!
  const agentName = input.agent_name ?? input.function

  return { ok: true, kind, agentId, agentName }
}
