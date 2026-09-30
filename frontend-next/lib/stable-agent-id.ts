/** Mirrors swarmtrace/tracer.py::_stable_agent_id so SDK, ingest and MCP derive agent ids the same way. */
import { createHash } from 'node:crypto'

/**
 * Derive a stable 64-hex-char agent_id from an identity string. The SDK
 * passes "{module}.{qualname}" (or an explicit name=), the MCP route passes
 * the function name. Same input always gives the same id.
 */
export function stableAgentId(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex')
}
