/**
 * Stable agent identity helper.
 *
 * Mirrors swarmtrace/tracer.py::_stable_agent_id so that all three trace
 * ingestion paths (SDK, /api/ingest backfill, /api/mcp) can share the same
 * derivation when needed.
 *
 * Extracted to its own module so it can be unit-tested directly (see
 * scripts/test-derive-agent-cards.mjs) instead of being inlined in both
 * the MCP route and the test — which would risk silent divergence.
 */
import { createHash } from 'node:crypto'

/**
 * Derive a stable 64-hex-char agent_id from an arbitrary identity string.
 *
 * - The SDK calls this with `"{module}.{qualname}"` (or an explicit `name=`).
 * - The MCP route calls this with the `function` name (no module concept in MCP).
 *
 * Same input → same output across calls, processes, and machines, so repeat
 * runs of the same logical agent collapse into one dashboard card.
 */
export function stableAgentId(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex')
}
