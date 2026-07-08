/**
 * Ingest payload validation — shared between the /api/ingest edge route and
 * its tests.
 *
 * Extracted from app/api/ingest/route.ts so the validation contract is
 * unit-testable without standing up the full edge runtime. The route file
 * imports {@link validateIngest} and {@link normalizeIngestPayload} from
 * here; tests import the same functions directly.
 *
 * Two payload shapes are accepted (swarmtrace 0.6.0+):
 *
 *   1. Single object (the original shape, still sent by older SDK versions):
 *
 *        { id: "...", function: "...", timestamp: "...", ... }
 *
 *   2. Batch shape (new — sent by the SDK when batching is enabled):
 *
 *        { traces: [ {...}, {...}, ... ] }
 *
 * The backend accepts BOTH so that:
 *   - Old SDK versions keep working against a new backend (no forced upgrade).
 *   - A new SDK can send batches against a new backend (the throughput win).
 *
 * A new SDK is NOT released until the new backend is confirmed live — see
 * the task 4 rollout note in the commit message. Sending a batch against an
 * OLD backend (which only accepts single-object) would 400.
 */

const MAX_TEXT_LEN = 4000

export const VALID_KINDS = new Set(['agent', 'tool', 'llm', 'function'])

export interface TraceRow {
  id:            string
  parent_id:     string | null
  function:      string
  args:          string
  output:        string
  latency_sec:   number
  error:         string | null
  timestamp:     string
  input_tokens:  number
  output_tokens: number
  cost_usd:      number
  kind:          string
  agent_id:      string
  agent_name:    string
  session_id:    string | null
}

export interface ValidationError {
  error: string
  // Index into the batch (0 for single-object). Absent for whole-body errors.
  index?: number
}

/**
 * Validate ONE trace object and return the normalized row, or an error.
 *
 * This is the same logic that lived inline in route.ts before task 4 —
 * extracted here so it can be tested directly and called in a loop for
 * batch payloads.
 */
export function validateTrace(payload: unknown): { row?: TraceRow; error?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return { error: 'Body must be a JSON object' }
  const p = payload as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64)
    return { error: 'id must be a non-empty string of at most 64 characters' }
  if (typeof p.function !== 'string' || p.function.length === 0 || p.function.length > 256)
    return { error: 'function must be a non-empty string of at most 256 characters' }
  if (typeof p.timestamp !== 'string' || Number.isNaN(Date.parse(p.timestamp)))
    return { error: 'timestamp must be a valid ISO 8601 string' }
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_TEXT_LEN) : '')
  const num  = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  // kind/agent_id/agent_name were added in swarmtrace 0.3.0. Older SDK versions
  // (or anything posting to /ingest directly) won't send them — default to
  // kind='agent', agent_id=id, agent_name=function, which reproduces the
  // pre-0.3.0 "every trace is its own agent" behavior exactly, so old
  // clients keep working without becoming phantom sub-agents of anything.
  const kind = typeof p.kind === 'string' && VALID_KINDS.has(p.kind) ? p.kind : 'agent'
  const agentId =
    typeof p.agent_id === 'string' && p.agent_id.length > 0 ? p.agent_id.slice(0, 64) : p.id
  const agentName =
    typeof p.agent_name === 'string' && p.agent_name.length > 0
      ? p.agent_name.slice(0, 256)
      : p.function
  // session_id (swarmtrace 0.5.0) groups multi-turn runs into one conversation.
  // Optional — older SDKs omit it, so it defaults to null.
  const sessionId =
    typeof p.session_id === 'string' && p.session_id.length > 0
      ? p.session_id.slice(0, 64)
      : null

  return {
    row: {
      id:            p.id,
      parent_id:     typeof p.parent_id === 'string' ? p.parent_id.slice(0, 64) : null,
      function:      p.function,
      args:          text(p.args),
      output:        text(p.output),
      latency_sec:   num(p.latency_sec),
      error:         typeof p.error === 'string' ? p.error.slice(0, MAX_TEXT_LEN) : null,
      timestamp:     p.timestamp,
      input_tokens:  Math.max(0, Math.trunc(num(p.input_tokens))),
      output_tokens: Math.max(0, Math.trunc(num(p.output_tokens))),
      cost_usd:      Math.max(0, num(p.cost_usd)),
      kind:          kind,
      agent_id:      agentId,
      agent_name:    agentName,
      session_id:    sessionId,
    },
  }
}

/**
 * Detect the payload shape (single-object vs batch) and return a uniform
 * list of trace objects to validate.
 *
 * - `{ traces: [...] }` → the array (batch shape, SDK 0.6.0+).
 * - `{ id: ... }`       → a one-element array wrapping the object (legacy).
 * - Anything else       → null (caller returns 400).
 *
 * The batch shape must have a non-empty array; an empty array is rejected
 * so a misconfigured SDK doesn't spam the endpoint with no-op POSTs.
 */
export function normalizeIngestPayload(payload: unknown): TraceRow[] | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const p = payload as Record<string, unknown>
  if (Array.isArray(p.traces)) {
    if (p.traces.length === 0) return null
    return p.traces as unknown as TraceRow[]
  }
  // Single-object shape — wrap in a one-element array so the caller can
  // treat both shapes uniformly.
  return [p as unknown as TraceRow]
}

/**
 * Validate an entire ingest payload (single-object OR batch) and return
 * either the list of valid rows, or the first error encountered.
 *
 * On the first invalid trace in a batch, we reject the WHOLE batch with
 * a 400 — this matches the original single-object behavior (one bad trace
 * = one 400) and lets the SDK retry the whole batch. Partial-accept would
 * complicate the SDK's sync-flag bookkeeping (which rows to mark synced?)
 * and isn't worth the throughput gain.
 *
 * The returned `rows` array preserves batch order. The optional `index`
 * field on the error identifies which trace in the batch was bad (0-based),
 * so the SDK can log which item caused the rejection.
 */
export function validateIngest(payload: unknown): { rows?: TraceRow[]; error?: ValidationError } {
  const traces = normalizeIngestPayload(payload)
  if (traces === null) {
    return { error: { error: 'Body must be a single trace object or { traces: [...] }' } }
  }
  const rows: TraceRow[] = []
  for (let i = 0; i < traces.length; i++) {
    const { row, error } = validateTrace(traces[i])
    if (!row) {
      return { error: { error: error!, index: i } }
    }
    rows.push(row)
  }
  return { rows }
}
