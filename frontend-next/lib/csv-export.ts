/**
 * CSV export helper with formula-injection neutralization.
 *
 * Audit finding (medium): the dashboard's exportCSV() in app/overview/page.tsx
 * and app/traces/page.tsx wrote trace-controlled values directly to CSV with
 * no leading =/+/-/@ neutralization. Trace args/output/error/function are
 * LLM-controlled or tool-controlled strings — a malicious prompt or tool
 * response can produce a value starting with =, +, -, or @, which
 * Excel/LibreOffice/Google Sheets will parse as a formula on open.
 *
 * Classic attacks:
 *   =cmd|'/c calc'!A1                 → Excel DDE command execution
 *   =HYPERLINK("http://evil","click") → phishing link
 *   @SUM(1+1)*cmd|'/c calc'!A1        → variant
 *
 * Mitigation: prefix a single quote (') to any cell value whose string form
 * starts with =, +, -, @, tab, or CR. The quote is the spreadsheet-standard
 * "this cell is text, not a formula" escape — Excel/Sheets display the value
 * without the quote but no longer parse it as a formula. OWASP-recommended.
 *
 * Both dashboard export call sites now route through this helper so the
 * fix lives in one place.
 */

import type { Trace } from './trace-types'

const CSV_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Prefix a single quote to a cell value that would otherwise be parsed as
 * a spreadsheet formula. Empty/null/undefined pass through as empty string
 * (CSV-safe; can't be formula-injected).
 */
export function sanitizeCsvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  if (s && CSV_INJECTION_PREFIXES.has(s[0])) {
    return "'" + s
  }
  return s
}

/**
 * Quote a cell for CSV if it contains a comma, double-quote, or newline.
 * Then run it through sanitizeCsvCell to neutralize formula injection.
 *
 * Order matters: sanitize FIRST (so the leading quote, if any, becomes
 * part of the cell content before CSV quoting decides whether to wrap it),
 * then CSV-escape. A leading "'" doesn't itself require CSV quoting, so
 * in practice the two operations are independent.
 */
function escapeAndSanitize(v: unknown): string {
  const s = sanitizeCsvCell(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Build a CSV string from a list of traces using the dashboard's standard
 * column set. Every cell is sanitized against formula injection.
 */
export function tracesToCsv(traces: Trace[]): string {
  if (traces.length === 0) return ''
  const headers = [
    'id', 'parent_id', 'function', 'kind', 'agent_name', 'timestamp',
    'latency_sec', 'input_tokens', 'output_tokens', 'cost_usd', 'error',
  ]
  const rows = [
    headers.join(','),
    ...traces.map(t => headers.map(h => escapeAndSanitize((t as Record<string, unknown>)[h])).join(',')),
  ]
  return rows.join('\n')
}

/**
 * Trigger a browser download of the given CSV string.
 */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Trigger a browser download of the given JSON string.
 */
export function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
