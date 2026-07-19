/**
 * Test: CSV export helper with formula-injection neutralization.
 *
 * Audit finding (medium): the dashboard's exportCSV() in app/overview/page.tsx
 * and app/traces/page.tsx wrote trace-controlled values directly to CSV with
 * no leading =/+/-/@ neutralization. Trace args/output/error/function are
 * LLM-controlled or tool-controlled strings — a malicious prompt or tool
 * response can produce a value starting with =, +, -, or @, which
 * Excel/LibreOffice/Google Sheets will parse as a formula on open.
 *
 * The fix (lib/csv-export.ts) prefixes a single quote to such values — the
 * spreadsheet-standard "this cell is text, not a formula" escape.
 * OWASP-recommended mitigation.
 *
 * These tests lock the sanitization in place for both the unit helper
 * (sanitizeCsvCell) and the end-to-end builder (tracesToCsv).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeCsvCell, tracesToCsv } from '../lib/csv-export.ts'

describe('sanitizeCsvCell — formula-injection neutralization', () => {
  test('neutralizes = prefix (DDE command injection)', () => {
    assert.equal(sanitizeCsvCell("=cmd|'/c calc'!A1"), "'=cmd|'/c calc'!A1")
  })

  test('neutralizes = prefix (HYPERLINK phishing)', () => {
    assert.equal(
      sanitizeCsvCell('=HYPERLINK("http://evil","click")'),
      "'=HYPERLINK(\"http://evil\",\"click\")"
    )
  })

  test('neutralizes + prefix', () => {
    assert.equal(sanitizeCsvCell('+1*HYPERLINK("x")'), "'+1*HYPERLINK(\"x\")")
  })

  test('neutralizes - prefix', () => {
    assert.equal(sanitizeCsvCell('-1+1'), "'-1+1")
  })

  test('neutralizes @ prefix (Lotus-style formula trigger)', () => {
    assert.equal(sanitizeCsvCell('@SUM(1+1)'), "'@SUM(1+1)")
  })

  test('neutralizes leading tab', () => {
    assert.equal(sanitizeCsvCell('\t=evil'), "'\t=evil")
  })

  test('neutralizes leading CR', () => {
    assert.equal(sanitizeCsvCell('\rcalc'), "'\rcalc")
  })

  test('passes through safe strings unchanged', () => {
    assert.equal(sanitizeCsvCell('normal output'), 'normal output')
    assert.equal(sanitizeCsvCell('hello =world'), 'hello =world')
    assert.equal(sanitizeCsvCell('[REDACTED]'), '[REDACTED]')
    assert.equal(sanitizeCsvCell('answer: 42'), 'answer: 42')
  })

  test('passes through non-strings as stringified, no prefix', () => {
    assert.equal(sanitizeCsvCell(42), '42')
    assert.equal(sanitizeCsvCell(0.001), '0.001')
    assert.equal(sanitizeCsvCell(true), 'true')
  })

  test('null and undefined become empty string', () => {
    assert.equal(sanitizeCsvCell(null), '')
    assert.equal(sanitizeCsvCell(undefined), '')
  })

  test('empty string passes through', () => {
    assert.equal(sanitizeCsvCell(''), '')
  })
})

describe('tracesToCsv — end-to-end formula-injection guard', () => {
  // Minimal fake trace type — Trace has many optional fields, but tracesToCsv
  // only reads a known column list.
  function mkTrace(overrides = {}) {
    return {
      id: 't1',
      parent_id: null,
      function: 'fn',
      kind: 'agent',
      agent_name: 'bot',
      timestamp: '2026-07-13T00:00:00Z',
      latency_sec: 0.1,
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.001,
      error: null,
      ...overrides,
    }
  }

  test('empty trace list produces empty string', () => {
    assert.equal(tracesToCsv([]), '')
  })

  test('header row is the standard column set', () => {
    const csv = tracesToCsv([mkTrace()])
    const lines = csv.split('\n')
    // Phase 5 added trace_id, session_id, and attributes to SpanRecord;
    // csv-export.ts surfaces all three, so the header grew from 11 to 14
    // columns.
    assert.equal(
      lines[0],
      'id,parent_id,trace_id,function,kind,agent_name,session_id,timestamp,latency_sec,input_tokens,output_tokens,cost_usd,error,attributes'
    )
  })

  test('trace with =-prefixed output gets sanitized', () => {
    // The output column isn't in the standard header set, so it won't appear
    // in the CSV at all. Test via the function column instead.
    const csv = tracesToCsv([mkTrace({ id: 'evil', function: "=cmd|'/c calc'!A1" })])
    const line = csv.split('\n')[1]
    // Phase 5 inserted trace_id before function, so function is now the
    // 4th field (index 3), not the 3rd. It should start with the escape
    // quote.
    const funcField = line.split(',')[3]
    assert.equal(funcField, "'=cmd|'/c calc'!A1", `got: ${funcField}`)
  })

  test('trace with +-prefixed error gets sanitized', () => {
    const csv = tracesToCsv([mkTrace({ id: 'e', error: '+HYPERLINK("http://evil")' })])
    const line = csv.split('\n')[1]
    // error used to be the last field; Phase 5 appended attributes after
    // it, so check the escaped/sanitized error segment appears in the
    // line rather than asserting it's the suffix. CSV escaping wraps it
    // in quotes (because it contains quotes) and doubles the inner quotes
    // per CSV standard. The leading ' (sanitization escape) must be the
    // first content char.
    assert.ok(
      line.includes(`"'+HYPERLINK(""http://evil"")"`),
      `got: ${line}`
    )
  })

  test('trace with normal values passes through unsanitized', () => {
    const csv = tracesToCsv([mkTrace({ id: 'safe', function: 'my_agent' })])
    const line = csv.split('\n')[1]
    const fields = line.split(',')
    assert.equal(fields[0], 'safe')
    assert.equal(fields[3], 'my_agent')
  })

  test('CSV-escaping (commas, quotes, newlines) still works alongside sanitization', () => {
    // A value with both a comma AND a = prefix should get BOTH the escape
    // quote (for sanitization) and double-quote wrapping (for CSV escaping).
    const csv = tracesToCsv([mkTrace({ id: 'x', function: '=evil,formula' })])
    const line = csv.split('\n')[1]
    // The function field should be quoted: "'=evil,formula"
    assert.ok(line.includes('"\'=evil,formula"'), `got: ${line}`)
  })

  test('regression: id field is never sanitized (IDs never start with =)', () => {
    // Sanity: a normal hex trace id should pass through untouched.
    const csv = tracesToCsv([mkTrace({ id: 'abc123def456' })])
    const line = csv.split('\n')[1]
    assert.equal(line.split(',')[0], 'abc123def456')
  })
})
