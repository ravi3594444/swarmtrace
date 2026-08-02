/**
 * Sanitization for the MCP record_trace path (app/api/mcp/route.ts).
 *
 * Why this exists: /api/ingest and /api/events redact free text at the
 * boundary (lib/redact.ts) before it reaches Supabase, and cap attributes
 * at MAX_ATTRIBUTES_SIZE. The MCP route's whole purpose is to serve
 * NON-SDK clients (Hermes, Claude Desktop, Cursor, ...) — clients where
 * the Python SDK's client-side redaction never runs. Before this module,
 * record_trace passed `args` / `output` / `error` / `attributes` straight
 * into `upsert_trace_for_key`, so PII/API keys embedded in MCP tool call
 * arguments landed unredacted in the database, and `attributes` was
 * unbounded (ingest caps it at 64 KB JSON).
 *
 * Rules mirror the ingest boundary exactly:
 *   - args/output/error: truncate to MAX_TEXT_LEN first, then redact
 *     (same order as lib/validate-ingest.ts) so we never redact past the
 *     truncation boundary.
 *   - attributes: must be a plain JSON object, JSON-serialized size ≤
 *     MAX_ATTRIBUTES_SIZE (64 KB). Invalid attributes reject the tool
 *     call with isError (consistent with the identity validation), rather
 *     than silently dropping metadata the caller expects to be stored.
 *
 * Pure functions — no I/O, safe to unit-test without the edge runtime.
 */
import { redact } from './redact'
import { MAX_TEXT_LEN, MAX_ATTRIBUTES_SIZE } from './validate-ingest'

export interface McpTraceFields {
  args?: string | null
  output?: string | null
  error?: string | null
  attributes?: unknown
}

export interface SanitizedMcpTrace {
  args: string
  output: string
  error: string | null
  attributes: Record<string, unknown> | null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT_LEN) : '')

const optText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return null
  const s = v.slice(0, MAX_TEXT_LEN)
  return s.length > 0 ? s : null
}

export function sanitizeMcpTraceFields(
  fields: McpTraceFields,
): { ok: true; value: SanitizedMcpTrace } | { ok: false; error: string } {
  let attributes: Record<string, unknown> | null = null
  if (fields.attributes !== undefined && fields.attributes !== null) {
    if (typeof fields.attributes !== 'object' || Array.isArray(fields.attributes)) {
      return { ok: false, error: 'attributes must be a JSON object' }
    }
    const attrString = JSON.stringify(fields.attributes)
    if (attrString.length > MAX_ATTRIBUTES_SIZE) {
      return { ok: false, error: `attributes JSON exceeds ${MAX_ATTRIBUTES_SIZE} bytes` }
    }
    attributes = fields.attributes as Record<string, unknown>
  }

  return {
    ok: true,
    value: {
      args: redact(text(fields.args))!,
      output: redact(text(fields.output))!,
      error: redact(optText(fields.error)),
      attributes,
    },
  }
}
