/**
 * Validation for /api/ingest payloads, kept separate from the route so it
 * can be unit tested.
 *
 * Two shapes are accepted: a single trace object (older SDKs) or a batch,
 * `{ traces: [...] }` (SDK 0.6.0+).
 */

export const MAX_TEXT_LEN = 32000

import { redact } from './redact'
import { decodeGzipBody } from './decode-body'

// Cap on the decompressed body. The wire size is already limited to 1 MB,
// but gzip can expand ~1000x. 1 MB still fits the largest real batch
// (50 traces of ~64 KB text).
export const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024

export const VALID_KINDS = new Set(['agent', 'tool', 'llm', 'function', 'retrieval'])

export const MAX_ATTRIBUTES_SIZE = 64 * 1024

/**
 * Decode the raw request body to a JSON string, inflating gzip when the
 * client sent Content-Encoding: gzip. Wraps decodeGzipBody with ingest's
 * size limit.
 */
export async function decodeIngestBody(
  bodyBytes: ArrayBuffer,
  contentEncoding: string | null,
): Promise<string> {
  return decodeGzipBody(bodyBytes, contentEncoding, MAX_DECOMPRESSED_BYTES)
}

export interface TraceRow {
  id:            string
  parent_id:     string | null
  trace_id:      string | null
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
  attributes:    Record<string, unknown> | null
}

export interface ValidationError {
  error: string
  // batch index (0 for single-object); absent for whole-body errors
  index?: number
}

/** Validate one trace object and return the normalized row or an error. */
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

  // kind/agent_id/agent_name came in with SDK 0.3.0. Older clients omit them,
  // so default to kind='agent', agent_id=id, agent_name=function, i.e. each
  // trace is its own agent.
  const kind = typeof p.kind === 'string' && VALID_KINDS.has(p.kind) ? p.kind : 'agent'
  const agentId =
    typeof p.agent_id === 'string' && p.agent_id.length > 0 ? p.agent_id.slice(0, 64) : p.id
  const agentName =
    typeof p.agent_name === 'string' && p.agent_name.length > 0
      ? p.agent_name.slice(0, 256)
      : p.function
  // session_id groups multi-turn runs into one conversation; optional.
  const sessionId =
    typeof p.session_id === 'string' && p.session_id.length > 0
      ? p.session_id.slice(0, 64)
      : null

  // trace_id is the distributed root run id; defaults to the span id.
  const traceId =
    typeof p.trace_id === 'string' && p.trace_id.length > 0
      ? p.trace_id.slice(0, 64)
      : p.id

  // attributes: generic JSON metadata. Optional, size-bounded, and must be a
  // plain object (not an array or primitive).
  let attributes: Record<string, unknown> | null = null
  if (p.attributes !== undefined && p.attributes !== null) {
    if (typeof p.attributes !== 'object' || Array.isArray(p.attributes)) {
      return { error: 'attributes must be a JSON object' }
    }
    const attrString = JSON.stringify(p.attributes)
    if (attrString.length > MAX_ATTRIBUTES_SIZE) {
      return { error: `attributes JSON exceeds ${MAX_ATTRIBUTES_SIZE} bytes` }
    }
    attributes = p.attributes as Record<string, unknown>
  }

  // PII redaction at the ingest boundary, since clients posting directly
  // (curl, MCP, third-party SDKs) skip the SDK's own redaction. Applies to
  // args/output/error, after slicing so we don't redact past the truncation
  // point. See lib/redact.ts.
  const argsRaw = text(p.args)
  const outputRaw = text(p.output)
  const errorRaw = typeof p.error === 'string' ? p.error.slice(0, MAX_TEXT_LEN) : null

  return {
    row: {
      id:            p.id,
      parent_id:     typeof p.parent_id === 'string' ? p.parent_id.slice(0, 64) : null,
      function:      p.function,
      args:          redact(argsRaw)!,
      output:        redact(outputRaw)!,
      latency_sec:   num(p.latency_sec),
      error:         redact(errorRaw),
      timestamp:     p.timestamp,
      input_tokens:  Math.max(0, Math.trunc(num(p.input_tokens))),
      output_tokens: Math.max(0, Math.trunc(num(p.output_tokens))),
      cost_usd:      Math.max(0, num(p.cost_usd)),
      kind:          kind,
      agent_id:      agentId,
      agent_name:    agentName,
      session_id:    sessionId,
      trace_id:      traceId,
      attributes:    attributes,
    },
  }
}

/**
 * Work out whether the payload is a single trace or a batch and return a
 * uniform list. `{ traces: [...] }` gives the array, `{ id: ... }` wraps the
 * object, anything else is null (400). Empty batches are rejected.
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
  // Single-object shape: wrap it so callers treat both shapes the same.
  return [p as unknown as TraceRow]
}

/**
 * Validate a whole ingest payload (single or batch). One bad trace rejects
 * the entire batch with a 400 so the SDK can retry it as a unit. Rows keep
 * batch order; the error's `index` (0-based) says which trace was bad.
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
