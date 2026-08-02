/**
 * Test: lib/validate-regression.ts — the /api/regression payload contract.
 *
 * The dashboard exposure for swarmtrace.regression (the PRD-flagged
 * unfinished item) accepts one payload shape from SDK 0.6.7+:
 *
 *   compare(..., report_to_dashboard=True) → POST /api/regression
 *
 * Covers:
 *   1. A well-formed run validates and normalizes (name sliced, optional
 *      prompts pass through, threshold defaults to 0.6 when absent).
 *   2. run_id is required, [A-Za-z0-9_-], 1..64 chars (idempotency key).
 *   3. results must be an array, capped at MAX_REGRESSION_RESULTS.
 *   4. Per-entry validation: non-object rejected, missing input rejected
 *      (with the entry index in the error), similarity clamped to 0..1,
 *      and `regressed` recomputed server-side as similarity < threshold.
 *   5. Free text is truncated to MAX_TEXT_LEN and PII-redacted before the
 *      row hits Supabase (same boundary defense as ingest).
 *   6. Non-object bodies are rejected.
 *
 * The HTTP route (app/api/regression/route.ts) delegates validation to
 * these pure functions; route-only concerns (auth, rate limits, body size,
 * the Supabase RPC) are integration concerns covered by the route code
 * review + Postgres integration tests.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateRegressionRun,
  validateRegressionResult,
  MAX_REGRESSION_RESULTS,
} from '../lib/validate-regression.ts'
import { MAX_TEXT_LEN } from '../lib/validate-ingest.ts'

function mkRun(overrides = {}) {
  return {
    run_id: 'run-' + Math.random().toString(36).slice(2, 10),
    threshold: 0.6,
    version_a_prompt: 'baseline prompt',
    version_b_prompt: 'candidate prompt',
    inputs_count: 1,
    regressions_count: 0,
    duration_sec: 3.2,
    results: [
      {
        input: 'What is ML?',
        output_a: 'Machine learning is…',
        output_b: 'ML is…',
        latency_a_sec: 1.1,
        latency_b_sec: 1.4,
        similarity: 0.9,
        regressed: false,
      },
    ],
    ...overrides,
  }
}

describe('validateRegressionRun — well-formed payloads', () => {
  test('accepts a well-formed run and preserves all fields', () => {
    const { run, error } = validateRegressionRun(mkRun())
    assert.equal(error, undefined)
    assert.equal(run.results.length, 1)
    assert.equal(run.results[0].similarity, 0.9)
    assert.equal(run.results[0].regressed, false)
    assert.equal(run.threshold, 0.6)
    assert.equal(run.version_a_prompt, 'baseline prompt')
    assert.equal(run.inputs_count, 1)
    assert.equal(run.regressions_count, 0)
  })

  test('recomputes regressed from similarity < threshold even when the client disagrees', () => {
    const { run } = validateRegressionRun(mkRun({
      threshold: 0.95,
      results: [{ input: 'x', similarity: 0.9, regressed: false }],
    }))
    assert.equal(run.results[0].regressed, true)
  })

  test('defaults missing threshold to the SDK default 0.6', () => {
    const { run } = validateRegressionRun(mkRun({ threshold: undefined }))
    assert.equal(run.threshold, 0.6)
  })

  test('clamps threshold into 0..1', () => {
    assert.equal(validateRegressionRun(mkRun({ threshold: 5 })).run.threshold, 1)
    assert.equal(validateRegressionRun(mkRun({ threshold: -2 })).run.threshold, 0)
  })

  test('accepts an empty results array (a run with zero inputs)', () => {
    const { run, error } = validateRegressionRun(mkRun({ results: [], inputs_count: 0 }))
    assert.equal(error, undefined)
    assert.deepEqual(run.results, [])
  })

  test('missing optional fields normalize to null/0', () => {
    const { run } = validateRegressionRun(mkRun({
      name: undefined, version_a_prompt: undefined, version_b_prompt: undefined,
    }))
    assert.equal(run.name, null)
    assert.equal(run.version_a_prompt, null)
    assert.equal(run.version_b_prompt, null)
  })

  test('slices long name and text fields to their caps', () => {
    const long = 'x'.repeat(MAX_TEXT_LEN + 500)
    const { run, error } = validateRegressionRun(mkRun({
      name: 'n'.repeat(300),
      version_a_prompt: long,
      results: [{ input: long, output_a: long }],
    }))
    assert.equal(error, undefined)
    assert.equal(run.name.length, 200)
    assert.equal(run.version_a_prompt.length, MAX_TEXT_LEN)
    assert.equal(run.results[0].input.length, MAX_TEXT_LEN)
  })
})

describe('validateRegressionRun — rejection cases', () => {
  test('rejects non-object bodies', () => {
    for (const bad of [null, 42, 'str', [1, 2], true]) {
      const { error } = validateRegressionRun(bad)
      assert.match(error.error, /JSON object/)
    }
  })

  test('run_id is required', () => {
    const { error } = validateRegressionRun(mkRun({ run_id: undefined }))
    assert.match(error.error, /run_id/)
  })

  test('run_id must be [A-Za-z0-9_-] and at most 64 chars', () => {
    for (const bad of ['', 'has spaces', 'has/slash', 'has.dot', 'x'.repeat(65)]) {
      const { error } = validateRegressionRun(mkRun({ run_id: bad }))
      assert.match(error.error, /run_id/, `expected rejection for ${JSON.stringify(bad)}`)
    }
    const { run } = validateRegressionRun(mkRun({ run_id: 'aB9_-ok' }))
    assert.equal(run.run_id, 'aB9_-ok')
  })

  test('results must be an array', () => {
    const { error } = validateRegressionRun(mkRun({ results: 'nope' }))
    assert.match(error.error, /results must be an array/)
  })

  test('rejects more than MAX_REGRESSION_RESULTS entries', () => {
    const results = Array.from({ length: MAX_REGRESSION_RESULTS + 1 }, (_, i) => ({
      input: `in-${i}`,
      similarity: 0.9,
    }))
    const { error } = validateRegressionRun(mkRun({ results }))
    assert.match(error.error, /exceeds/)
  })

  test('rejects a non-object entry and reports its index', () => {
    const { error } = validateRegressionRun(mkRun({ results: [{ input: 'ok', similarity: 0.8 }, 'bad'] }))
    assert.equal(error.index, 1)
    assert.match(error.error, /JSON object/)
  })

  test('rejects an entry with a missing/empty input', () => {
    const { error } = validateRegressionRun(mkRun({ results: [{ similarity: 0.8 }] }))
    assert.equal(error.index, 0)
    assert.match(error.error, /input must be a non-empty string/)
  })
})

describe('validateRegressionRun — PII redaction at the boundary', () => {
  test('redacts emails and API keys from input/output/prompts', () => {
    const { run } = validateRegressionRun(mkRun({
      version_a_prompt: 'email admin@example.com key sk-abcdefghijklmnopqrstuvwxyz123456',
      results: [{
        input: 'contact dev@example.com',
        output_a: 'token ghp_abcdefghijklmnopqrstuvwxyz1234567890',
        similarity: 0.8,
      }],
    }))
    assert.equal(run.version_a_prompt.includes('admin@example.com'), false)
    assert.equal(run.version_a_prompt.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), false)
    assert.equal(run.version_a_prompt.includes('[REDACTED]'), true)
    assert.equal(run.results[0].input, 'contact [REDACTED]')
    assert.equal(run.results[0].output_a.includes('ghp_'), false)
    assert.equal(run.results[0].output_a.includes('[REDACTED]'), true)
  })
})

describe('validateRegressionResult — standalone entry validation', () => {
  test('clamps similarity to 0..1 and coerces latencies', () => {
    const { result } = validateRegressionResult({
      input: 'x', similarity: 5, latency_a_sec: -3, latency_b_sec: 'nope',
    })
    assert.equal(result.similarity, 1)
    assert.equal(result.latency_a_sec, 0)
    assert.equal(result.latency_b_sec, 0)
  })

  test('defaults similarity to 0 (neutral-ish floor) when absent', () => {
    const { result } = validateRegressionResult({ input: 'x' })
    assert.equal(result.similarity, 0)
    // 0 < default threshold 0.6 → flagged as regressed (fail-safe: unknown
    // similarity is treated as a regression, never a silent pass).
    assert.equal(result.regressed, true)
  })
})
