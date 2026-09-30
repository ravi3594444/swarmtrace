/**
 * Tests for lib/csv-export.ts: sanitizeCsvCell and tracesToCsv must
 * neutralize values starting with =, +, -, @, tab or CR so spreadsheets
 * don't run them as formulas.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeCsvCell, tracesToCsv } from '../lib/csv-export.ts'

describe('sanitizeCsvCell: formula-injection neutralization', () => {
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

describe('tracesToCsv: end-to-end formula-injection guard', () => {
  // minimal fake trace; tracesToCsv only reads a known column list
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
    // header includes trace_id, session_id and attributes
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
    // function is the 4th field (index 3) and should start with the escape quote
    const funcField = line.split(',')[3]
    assert.equal(funcField, "'=cmd|'/c calc'!A1", `got: ${funcField}`)
  })

  test('trace with +-prefixed error gets sanitized', () => {
    const csv = tracesToCsv([mkTrace({ id: 'e', error: '+HYPERLINK("http://evil")' })])
    const line = csv.split('\n')[1]
    // error isn't the last column, so look for the escaped segment in the
    // line. It's CSV-quoted with inner quotes doubled, and the leading '
    // must come first.
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
    // comma plus a = prefix gets both the escape quote and CSV quoting
    const csv = tracesToCsv([mkTrace({ id: 'x', function: '=evil,formula' })])
    const line = csv.split('\n')[1]
    // expected field: "'=evil,formula"
    assert.ok(line.includes('"\'=evil,formula"'), `got: ${line}`)
  })

  test('id field is never sanitized (IDs never start with =)', () => {
    const csv = tracesToCsv([mkTrace({ id: 'abc123def456' })])
    const line = csv.split('\n')[1]
    assert.equal(line.split(',')[0], 'abc123def456')
  })
})
