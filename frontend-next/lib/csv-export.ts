/**
 * CSV export helpers. Trace args/output/error are LLM or tool controlled, so a
 * cell starting with =, +, -, @, tab or CR could run as a formula in
 * Excel/Sheets. Such cells get a leading single quote (the standard OWASP
 * mitigation).
 */

import type { Trace } from './trace-types'

const CSV_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Prefix a single quote to values a spreadsheet would parse as a formula.
 * Empty/null/undefined become an empty string.
 */
export function sanitizeCsvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  if (s && CSV_INJECTION_PREFIXES.has(s[0])) {
    return "'" + s
  }
  return s
}

/**
 * Quote a cell for CSV if it has a comma, double-quote or newline, after
 * running it through sanitizeCsvCell.
 */
function escapeAndSanitize(v: unknown): string {
  const s = sanitizeCsvCell(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** Build a CSV string from traces using the dashboard's standard columns, sanitizing every cell. */
export function tracesToCsv(traces: Trace[]): string {
  if (traces.length === 0) return ''
  const headers = [
    'id', 'parent_id', 'trace_id', 'function', 'kind', 'agent_name', 'session_id', 'timestamp',
    'latency_sec', 'input_tokens', 'output_tokens', 'cost_usd', 'error', 'attributes',
  ]
  const rows = [
    headers.join(','),
    ...traces.map(t => headers.map(h => escapeAndSanitize((t as Record<string, unknown>)[h])).join(',')),
  ]
  return rows.join('\n')
}

/** Trigger a browser download of the given CSV string. */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Trigger a browser download of the given JSON string. */
export function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
