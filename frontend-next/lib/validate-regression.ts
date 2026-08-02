/**
 * Regression-run payload validation — shared between the /api/regression
 * route and its tests.
 *
 * Mirrors lib/validate-ingest.ts conventions: the route imports the
 * validator here, tests import the same functions directly, and free-text
 * fields are truncated to the shared MAX_TEXT_LEN and PII-redacted BEFORE
 * they reach Supabase (defense-in-depth — the SDK redacts too, but any
 * client that posts directly bypasses the SDK).
 *
 * The payload shape (sent by swarmtrace.regression.compare(...,
 * report_to_dashboard=True) — SDK 0.6.7+):
 *
 *   {
 *     run_id: "…",                     // client idempotency key (unique per user)
 *     name: "optional run name",
 *     threshold: 0.6,                  // 0..1
 *     version_a_prompt: "…",
 *     version_b_prompt: "…",
 *     inputs_count: 3,
 *     regressions_count: 1,
 *     duration_sec: 12.4,
 *     results: [
 *       {
 *         input: "…",
 *         output_a: "…",
 *         output_b: "…",
 *         latency_a_sec: 1.2,
 *         latency_b_sec: 1.5,
 *         similarity: 0.42,
 *         regressed: true,
 *       }
 *     ]
 *   }
 *
 * Validation rules:
 *   - run_id: required, 1..64 chars, [A-Za-z0-9_-] only (safe to use as an
 *     idempotency key in the DB unique constraint).
 *   - results: required array, capped at MAX_REGRESSION_RESULTS entries.
 *   - Free text (prompts, input, outputs): sliced to MAX_TEXT_LEN then
 *     redacted — same order as the ingest path.
 *   - Numeric fields: coerced with the same rules as ingest (non-finite or
 *     wrong-typed values become 0); similarity is clamped to 0..1.
 *   - `regressed` is recomputed server-side as similarity < threshold so
 *     the flag is always consistent with the run's own threshold, even for
 *     third-party clients that omit or disagree on it.
 */

import { redact } from './redact'
import { MAX_TEXT_LEN } from './validate-ingest'

export const MAX_REGRESSION_RESULTS = 200

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface RegressionResultInput {
  input: string
  output_a: string | null
  output_b: string | null
  latency_a_sec: number
  latency_b_sec: number
  similarity: number
  regressed: boolean
}

export interface RegressionRun {
  run_id: string
  name: string | null
  threshold: number
  version_a_prompt: string | null
  version_b_prompt: string | null
  inputs_count: number
  regressions_count: number
  duration_sec: number
  results: RegressionResultInput[]
}

export interface ValidationError {
  error: string
  // Index into the results array, when the error is about one entry.
  index?: number
}

const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_TEXT_LEN) : '')
const optText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return null
  const s = v.slice(0, MAX_TEXT_LEN)
  return s.length > 0 ? s : null
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Validate one per-input result entry. */
export function validateRegressionResult(
  payload: unknown,
): { result?: RegressionResultInput; error?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return { error: 'each result must be a JSON object' }
  const p = payload as Record<string, unknown>

  if (typeof p.input !== 'string' || p.input.length === 0)
    return { error: 'result input must be a non-empty string' }

  const input = redact(text(p.input))!
  const similarity = clamp01(num(p.similarity))
  const threshold = p.threshold === undefined || p.threshold === null
    ? 0.6  // SDK default — mirrors DEFAULT_THRESHOLD in swarmtrace/regression.py
    : clamp01(num(p.threshold))

  return {
    result: {
      input,
      output_a: redact(optText(p.output_a)),
      output_b: redact(optText(p.output_b)),
      latency_a_sec: Math.max(0, num(p.latency_a_sec)),
      latency_b_sec: Math.max(0, num(p.latency_b_sec)),
      similarity,
      // Recompute so the flag is always consistent with the run threshold.
      regressed: similarity < threshold,
    },
  }
}

/**
 * Validate a complete regression-run payload. Returns the normalized run
 * or the first error. On any error the whole payload is rejected (the SDK
 * treats the report as best-effort and just logs, so rejecting is simpler
 * and safer than partial-accept).
 */
export function validateRegressionRun(
  payload: unknown,
): { run?: RegressionRun; error?: ValidationError } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return { error: { error: 'Body must be a JSON object' } }
  const p = payload as Record<string, unknown>

  if (typeof p.run_id !== 'string' || !RUN_ID_RE.test(p.run_id))
    return { error: { error: 'run_id must be 1-64 characters of [A-Za-z0-9_-]' } }

  const name = typeof p.name === 'string' && p.name.length > 0
    ? p.name.slice(0, 200)
    : null

  const threshold = p.threshold === undefined || p.threshold === null
    ? 0.6  // SDK default — mirrors DEFAULT_THRESHOLD in swarmtrace/regression.py
    : clamp01(num(p.threshold))

  if (!Array.isArray(p.results))
    return { error: { error: 'results must be an array' } }
  if (p.results.length > MAX_REGRESSION_RESULTS)
    return { error: { error: `results exceeds ${MAX_REGRESSION_RESULTS} entries (got ${p.results.length})` } }

  const results: RegressionResultInput[] = []
  for (let i = 0; i < p.results.length; i++) {
    const entry = p.results[i]
    // Check object-ness HERE (before the spread) so a non-object entry
    // (string, number, array) is rejected with its index instead of being
    // silently spread into an object of character keys.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      return { error: { error: 'each result must be a JSON object', index: i } }

    const { result, error } = validateRegressionResult({
      ...(entry as Record<string, unknown>),
      threshold, // run-level threshold wins over any per-entry value
    })
    if (!result) return { error: { error: error!, index: i } }
    results.push(result)
  }

  const regressionsCount = Math.max(0, Math.trunc(num(p.regressions_count)))
  const inputsCount = Math.max(0, Math.trunc(num(p.inputs_count)))

  return {
    run: {
      run_id: p.run_id,
      name,
      threshold,
      version_a_prompt: redact(optText(p.version_a_prompt)),
      version_b_prompt: redact(optText(p.version_b_prompt)),
      inputs_count: inputsCount,
      regressions_count: regressionsCount,
      duration_sec: Math.max(0, num(p.duration_sec)),
      results,
    },
  }
}
