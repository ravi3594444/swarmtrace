/**
 * Resolves (kind, agent_id, agent_name) for an MCP record_trace call. Kept
 * out of the route so it can be unit tested (scripts/test-resolve-trace-identity.mjs).
 *
 * kind comes from the caller and defaults to 'agent'. MCP calls are
 * stateless, so agent_id is required whenever kind isn't 'agent'; for
 * 'agent' it defaults to a stable SHA-256 of `function`, so repeat calls
 * collapse into one card like a bare @observe does.
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
