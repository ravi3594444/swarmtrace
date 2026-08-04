/**
 * Test: ingest error classification (lib/ingest-errors.ts).
 *
 * The classifier is the fix for the "valid API key, zero traces, opaque
 * 500" failure mode: PostgREST/Postgres/network failures must map to stable
 * codes + actionable hints, without ever copying raw DB error text into the
 * response body.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifySupabaseError,
  ingestErrorBody,
  MIGRATION_HINT,
} from '../lib/ingest-errors.ts'

// Realistic PostgREST error payloads, as embedded in our supa()/supaRpc()
// "Supabase <status>: <body>" / "Supabase RPC <fn> <status>: <body>" errors.
const PGRST202_FN =
  'Supabase RPC upsert_trace_for_key 404: {"code":"PGRST202","details":null,' +
  '"hint":null,"message":"Could not find the function ' +
  'public.upsert_trace_for_key(p_agent_id, p_agent_name, p_args, p_attributes, ' +
  'p_cost_usd, p_error, p_function, p_id, p_input_tokens, p_key_hash, p_kind, ' +
  'p_latency_sec, p_output, p_output_tokens, p_parent_id, p_session_id, ' +
  'p_timestamp, p_trace_id) in the schema cache"}'
const UNDEFINED_COLUMN =
  'Supabase 400: {"code":"42703","details":null,"hint":null,' +
  '"message":"column traces.attributes does not exist"}'
const UNDEFINED_TABLE =
  'Supabase 400: {"code":"42P01","details":null,"hint":null,' +
  '"message":"relation \"public.traces\" does not exist"}'
const PGRST205_TABLE =
  'Supabase 404: {"code":"PGRST205","details":null,"hint":null,' +
  '"message":"Could not find the table \'public.traces\' in the schema cache"}'

describe('classifySupabaseError — schema drift (the production root cause)', () => {
  test('PGRST202 function-not-found → SCHEMA_NOT_MIGRATED', () => {
    const { code, hint } = classifySupabaseError(new Error(PGRST202_FN))
    assert.equal(code, 'SCHEMA_NOT_MIGRATED')
    assert.equal(hint, MIGRATION_HINT)
    assert.match(hint, /migrations/)
    assert.match(hint, /health\/db/)
  })

  test('PGRST205 table-not-found → SCHEMA_NOT_MIGRATED', () => {
    assert.equal(classifySupabaseError(new Error(PGRST205_TABLE)).code, 'SCHEMA_NOT_MIGRATED')
  })

  test('undefined column (42703) → SCHEMA_NOT_MIGRATED', () => {
    assert.equal(classifySupabaseError(new Error(UNDEFINED_COLUMN)).code, 'SCHEMA_NOT_MIGRATED')
  })

  test('undefined table (42P01) → SCHEMA_NOT_MIGRATED', () => {
    assert.equal(classifySupabaseError(new Error(UNDEFINED_TABLE)).code, 'SCHEMA_NOT_MIGRATED')
  })

  test('plain-English schema-cache miss → SCHEMA_NOT_MIGRATED', () => {
    assert.equal(
      classifySupabaseError(
        new Error('Could not find the function public.upsert_trace_for_key in the schema cache'),
      ).code,
      'SCHEMA_NOT_MIGRATED',
    )
  })
})

describe('classifySupabaseError — availability + timeouts', () => {
  test('Supabase 5xx → DB_UNAVAILABLE', () => {
    assert.equal(
      classifySupabaseError(new Error('Supabase 503: {"message":"upstream connect error"}')).code,
      'DB_UNAVAILABLE',
    )
    assert.equal(
      classifySupabaseError(new Error('Supabase RPC upsert_trace_for_key 502: bad gateway')).code,
      'DB_UNAVAILABLE',
    )
  })

  test('network failure (undici) → DB_UNAVAILABLE', () => {
    assert.equal(
      classifySupabaseError(new TypeError('fetch failed')).code,
      'DB_UNAVAILABLE',
    )
    assert.equal(
      classifySupabaseError(new Error('connect ECONNREFUSED 76.76.21.21:443')).code,
      'DB_UNAVAILABLE',
    )
  })

  test('timeouts → DB_TIMEOUT', () => {
    const t = new Error('The operation timed out')
    t.name = 'TimeoutError'
    assert.equal(classifySupabaseError(t).code, 'DB_TIMEOUT')
    const a = new Error('This operation was aborted')
    a.name = 'AbortError'
    assert.equal(classifySupabaseError(a).code, 'DB_TIMEOUT')
  })
})

describe('classifySupabaseError — everything else stays generic', () => {
  test('unique violation / random Postgres error → DB_ERROR', () => {
    assert.equal(
      classifySupabaseError(
        new Error('Supabase 400: {"code":"23505","message":"duplicate key value violates unique constraint"}'),
      ).code,
      'DB_ERROR',
    )
    assert.equal(classifySupabaseError(new Error('something entirely unexpected')).code, 'DB_ERROR')
    assert.equal(classifySupabaseError('a non-Error throw').code, 'DB_ERROR')
  })
})

describe('ingestErrorBody — public response shape', () => {
  test('never leaks raw database error text', () => {
    for (const raw of [PGRST202_FN, UNDEFINED_COLUMN, 'boom', new TypeError('fetch failed')]) {
      const err = raw instanceof Error ? raw : new Error(raw)
      const body = ingestErrorBody(classifySupabaseError(err))
      const serialized = JSON.stringify(body)
      assert.ok(!serialized.includes('traces.attributes'), serialized)
      assert.ok(!serialized.includes('schema cache'), serialized)
      assert.ok(!serialized.includes('PGRST'), serialized)
      assert.ok(typeof body.error === 'string' && body.error.length > 0)
      assert.ok(typeof body.hint === 'string' && body.hint.length > 0)
      assert.match(body.code, /^(SCHEMA_NOT_MIGRATED|DB_UNAVAILABLE|DB_TIMEOUT|DB_ERROR)$/)
    }
  })

  test('codes map to distinct, human-readable errors', () => {
    assert.match(ingestErrorBody({ code: 'SCHEMA_NOT_MIGRATED', hint: 'h' }).error, /schema is not migrated/)
    assert.match(ingestErrorBody({ code: 'DB_UNAVAILABLE', hint: 'h' }).error, /unavailable/)
    assert.match(ingestErrorBody({ code: 'DB_TIMEOUT', hint: 'h' }).error, /timeout/)
    assert.match(ingestErrorBody({ code: 'DB_ERROR', hint: 'h' }).error, /database error/)
  })
})
