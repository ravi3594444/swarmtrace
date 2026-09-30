/**
 * Tests for lib/schema-health.ts against an in-memory fake of PostgREST
 * (table to columns, function to parameters): healthy, fresh project (only
 * 0000 applied), partially migrated, stale RPC signatures and unreachable DB.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkSchemaHealth,
  TABLE_CHECKS,
  RPC_CHECKS,
  FAKE_KEY_HASH,
} from '../lib/schema-health.ts'
import { MIGRATION_HINT } from '../lib/ingest-errors.ts'

const SUPA_URL = 'https://proj.supabase.co'
const KEY = 'service-role-key'

// Mimics PostgREST: GET /<table>?select=a,b&limit=0 gives 200 only if the
// table and all columns exist (404 PGRST205 for a missing table, 400 42703
// for a missing column). POST /rpc/<fn> needs exact parameter names, else 404
// PGRST202, and *_for_key functions reject the fake hash with 400 28000
// invalid_api_key.
function resp(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

function makeDbFetch({ tables = {}, rpcs = {} } = {}) {
  return async (url, opts = {}) => {
    const u = new URL(url)
    if (u.pathname === '/rest/v1/' || u.pathname === '/rest/v1') {
      return resp(200, '{}')
    }
    const rpc = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/)
    if (rpc) {
      const fn = rpc[1]
      const sig = rpcs[fn]
      const given = Object.keys(JSON.parse(opts.body ?? '{}'))
      if (!sig || given.some((p) => !sig.includes(p))) {
        return resp(
          404,
          `{"code":"PGRST202","message":"Could not find the function public.${fn}(${given.join(', ')}) in the schema cache"}`,
        )
      }
      return resp(400, '{"code":"28000","message":"invalid_api_key","details":null,"hint":null}')
    }
    const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/)
    const table = m[1]
    const cols = tables[table]
    if (!cols) {
      return resp(
        404,
        `{"code":"PGRST205","message":"Could not find the table 'public.${table}' in the schema cache"}`,
      )
    }
    const select = (u.searchParams.get('select') ?? '').split(',').filter(Boolean)
    const missingCol = select.find((c) => !cols.has(c))
    if (missingCol) {
      return resp(
        400,
        `{"code":"42703","message":"column ${table}.${missingCol} does not exist"}`,
      )
    }
    return resp(200, '[]')
  }
}

/** A database with EVERYTHING the checker wants. */
function fullDb() {
  const tables = {}
  for (const tc of TABLE_CHECKS) {
    tables[tc.table] = new Set([...(tables[tc.table] ?? []), ...tc.columns])
  }
  const rpcs = {}
  for (const rc of RPC_CHECKS) rpcs[rc.fn] = Object.keys(rc.params)
  return makeDbFetch({ tables, rpcs })
}

/** A database exactly as created by 0000_init_tables.sql only. */
function fresh0000Db() {
  return makeDbFetch({
    tables: {
      api_keys: new Set(['id', 'key_hash', 'key_prefix', 'user_id', 'name', 'created_at', 'last_used', 'revoked']),
      traces: new Set(['id', 'user_id', 'parent_id', 'function', 'args', 'output', 'latency_sec', 'error', 'timestamp', 'input_tokens', 'output_tokens', 'cost_usd']),
    },
  })
}

// Key creation worked (0000 exists) but the other migrations were never applied.
describe('checkSchemaHealth: fresh project (only 0000 applied)', () => {
  test('reports every pending migration in repo order, RPCs included', async () => {
    const result = await checkSchemaHealth({
      url: SUPA_URL, serviceKey: KEY, fetchImpl: fresh0000Db(),
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missingMigrations, [
      '0002_daily_metrics.sql',
      '0003_trace_kind.sql',
      '0004_agent_events.sql',
      '0006_user_integrations.sql',
      '0008_session_id.sql',
      '0009_trace_metadata.sql',
      '0010_tenant_isolation_ingest.sql',
      '0011_regression_runs.sql',
    ])
    assert.equal(result.hint, MIGRATION_HINT)

    // checks that should pass on a 0000-only database do pass
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]))
    assert.equal(byName['api_keys table'].ok, true)
    assert.equal(byName['traces base columns'].ok, true)

    // and the ingest-critical ones fail with the right fix pointers
    assert.equal(byName['upsert_trace_for_key()'].ok, false)
    assert.equal(byName['upsert_trace_for_key()'].fix, '0010_tenant_isolation_ingest.sql')
    assert.equal(byName['upsert_trace_for_key()'].failure, 'missing')
    assert.equal(byName['traces metadata columns'].fix, '0009_trace_metadata.sql')
  })
})

describe('checkSchemaHealth: healthy deployment', () => {
  test('all checks pass, no hint, no missing migrations', async () => {
    const result = await checkSchemaHealth({ url: SUPA_URL, serviceKey: KEY, fetchImpl: fullDb() })
    assert.equal(result.ok, true)
    assert.deepEqual(result.missingMigrations, [])
    assert.equal(result.hint, undefined)
    assert.ok(result.checks.every((c) => c.ok))
  })

  test('RPC probes always send the fake key hash and full signatures', async () => {
    const seen = []
    const spy = async (url, opts = {}) => {
      if (url.includes('/rpc/')) seen.push(JSON.parse(opts.body))
      return fullDb()(url, opts)
    }
    await checkSchemaHealth({ url: SUPA_URL, serviceKey: KEY, fetchImpl: spy })
    assert.equal(seen.length, RPC_CHECKS.length)
    for (const body of seen) {
      assert.equal(body.p_key_hash, FAKE_KEY_HASH)
    }
  })
})

describe('checkSchemaHealth: partially migrated ', () => {
  test('stale RPC signature (function exists but older param list) is reported missing', async () => {
    const tables = {}
    for (const tc of TABLE_CHECKS) {
      tables[tc.table] = new Set([...(tables[tc.table] ?? []), ...tc.columns])
    }
    const rpcs = {}
    for (const rc of RPC_CHECKS) rpcs[rc.fn] = Object.keys(rc.params)
    // Stale 0010: upsert_trace_for_key without p_trace_id / p_attributes.
    rpcs.upsert_trace_for_key = rpcs.upsert_trace_for_key.filter(
      (p) => p !== 'p_trace_id' && p !== 'p_attributes',
    )
    const result = await checkSchemaHealth({
      url: SUPA_URL, serviceKey: KEY, fetchImpl: makeDbFetch({ tables, rpcs }),
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missingMigrations, ['0010_tenant_isolation_ingest.sql'])
    const c = result.checks.find((c) => c.name === 'upsert_trace_for_key()')
    assert.equal(c.failure, 'missing')
  })

  test('RPC permission problem (grant missing) is flagged as misconfigured with fix pointer', async () => {
    const fetchImpl = async (url, opts = {}) => {
      if (url.includes('/rpc/insert_agent_event_for_key')) {
        return resp(403, '{"code":"42501","message":"permission denied for function"}')
      }
      return fullDb()(url, opts)
    }
    const result = await checkSchemaHealth({ url: SUPA_URL, serviceKey: KEY, fetchImpl })
    assert.equal(result.ok, false)
    const c = result.checks.find((c) => c.name === 'insert_agent_event_for_key()')
    assert.equal(c.ok, false)
    assert.equal(c.failure, 'misconfigured')
    assert.equal(c.fix, '0010_tenant_isolation_ingest.sql')
  })
})

describe('checkSchemaHealth: database unreachable', () => {
  test('short-circuits with SUPABASE_URL hint, no crash', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    const result = await checkSchemaHealth({ url: SUPA_URL, serviceKey: KEY, fetchImpl })
    assert.equal(result.ok, false)
    assert.equal(result.checks.length, 1)
    assert.equal(result.checks[0].failure, 'unreachable')
    assert.deepEqual(result.missingMigrations, [])
    assert.match(result.hint, /SUPABASE_URL/)
  })
})

describe('checkSchemaHealth: never throws on odd responses', () => {
  test('a 500 from every request yields failed checks, still structured', async () => {
    const fetchImpl = async (url) => {
      if (/rest\/v1\/?$/.test(url)) return resp(200, '{}')
      return resp(500, 'Internal Server Error')
    }
    const result = await checkSchemaHealth({ url: SUPA_URL, serviceKey: KEY, fetchImpl })
    assert.equal(result.ok, false)
    assert.ok(result.checks.length > 1)
    assert.ok(result.checks.filter((c) => !c.ok).every((c) => c.failure))
  })
})
