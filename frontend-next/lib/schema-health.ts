/**
 * Schema health check — verifies the Supabase project actually has the
 * objects the app depends on, and names the exact migration file to run
 * when something is missing.
 *
 * Serves GET /api/health/db. Written as a pure function with an injected
 * fetch so it is unit-testable without network, Next, or env vars.
 *
 * WHY THIS EXISTS: "valid API key, zero traces on dashboard, opaque 500s"
 * is what you get when the dashboard is deployed but its migrations were
 * never applied (or only 0000 was). Before this endpoint, the only way to
 * discover that was reading Vercel function logs. Now:
 *
 *     curl https://<deployment>/api/health/db
 *     → { ok: false, missingMigrations: ["0010_tenant_isolation_ingest.sql"], … }
 *
 * WHAT IT CHECKS (read-only, no user data touched):
 *   1. PostgREST reachability.
 *   2. Every table/column group the app reads or writes, via
 *      `GET <table>?select=<cols>&limit=0` — PostgREST answers 200 only if
 *      ALL selected columns exist, and its error text (42P01 / 42703 /
 *      "column … does not exist") tells us exactly what's missing.
 *   3. Every SECURITY DEFINER RPC, probed with a syntactically-valid fake
 *      key hash and ITS FULL parameter list. All four *_for_key functions
 *      resolve the key FIRST and raise `invalid_api_key` (SQLSTATE 28000)
 *      before writing anything, so a 400/28000 answer proves the function
 *      exists with the current signature. PGRST202 proves it is missing —
 *      including "exists but with an older signature" (PostgREST matches
 *      RPCs by name+parameter names, so passing the full 2010-era arg list
 *      fails against any stale definition).
 *
 * SECURITY: results reveal which of this (open-source) project's own
 * schema objects exist — no user data, no key material, no row counts.
 * The route adds per-IP rate limiting.
 */

import { MIGRATION_HINT } from './ingest-errors'

export const FAKE_KEY_HASH = 'f'.repeat(64) // 64 hex chars: passes length guard, matches nothing

export interface SchemaCheck {
  /** Human-readable check name, e.g. "traces metadata columns". */
  name: string
  ok: boolean
  /** Which migration file provides this object (populated when ok=false). */
  fix?: string
  /** Class of failure for quick scanning: 'unreachable' | 'missing' | 'error'. */
  failure?: 'unreachable' | 'missing' | 'error' | 'misconfigured'
}

export interface SchemaHealth {
  ok: boolean
  checks: SchemaCheck[]
  /** Migration files to apply, in repo order, deduplicated. Empty when ok. */
  missingMigrations: string[]
  hint?: string
}

export interface TableCheck {
  name: string
  table: string
  columns: string[]
  fix: string
}

/** Column-group checks. Grouped so a failure names the precise file.
 * Exported for tests and docs generation. */
export const TABLE_CHECKS: TableCheck[] = [
  { name: 'api_keys table',               table: 'api_keys',        fix: '0000_init_tables.sql',
    columns: ['id', 'key_hash', 'key_prefix', 'user_id', 'name', 'created_at', 'last_used', 'revoked'] },
  { name: 'traces base columns',          table: 'traces',          fix: '0000_init_tables.sql',
    columns: ['id', 'user_id', 'parent_id', 'function', 'args', 'output', 'latency_sec', 'error', 'timestamp', 'input_tokens', 'output_tokens', 'cost_usd'] },
  { name: 'daily_metrics table',          table: 'daily_metrics',   fix: '0002_daily_metrics.sql',
    columns: ['user_id', 'date', 'cost_usd', 'input_tokens', 'output_tokens', 'trace_count'] },
  { name: 'traces kind columns',          table: 'traces',          fix: '0003_trace_kind.sql',
    columns: ['kind', 'agent_id', 'agent_name'] },
  { name: 'agent_events table',           table: 'agent_events',    fix: '0004_agent_events.sql',
    columns: ['id', 'user_id', 'agent_id', 'agent_name', 'event_type', 'status', 'data', 'timestamp'] },
  { name: 'user_integrations table',      table: 'user_integrations', fix: '0006_user_integrations.sql',
    columns: ['user_id', 'integration_id', 'connected', 'connected_at', 'updated_at'] },
  { name: 'traces session_id column',     table: 'traces',          fix: '0008_session_id.sql',
    columns: ['session_id'] },
  { name: 'traces metadata columns',      table: 'traces',          fix: '0009_trace_metadata.sql',
    columns: ['trace_id', 'attributes'] },
  { name: 'regression_runs table',        table: 'regression_runs', fix: '0011_regression_runs.sql',
    columns: ['id', 'user_id', 'run_id', 'name', 'threshold', 'inputs_count', 'regressions_count', 'duration_sec', 'results', 'created_at'] },
]

export interface RpcCheck {
  name: string
  fn: string
  params: Record<string, unknown>
  fix: string
}

/**
 * RPC probes — EVERY parameter of the current signature is sent so that a
 * stale (older-signature) definition fails the match, not just a missing
 * one. All functions validate the key first, so with a fake hash they
 * answer 400/28000 'invalid_api_key' and write nothing. Exported for tests.
 */
export const RPC_CHECKS: RpcCheck[] = [
  { name: 'resolve_api_key_user_id()', fn: 'resolve_api_key_user_id', fix: '0010_tenant_isolation_ingest.sql',
    params: { p_key_hash: FAKE_KEY_HASH } },
  { name: 'upsert_trace_for_key()', fn: 'upsert_trace_for_key', fix: '0010_tenant_isolation_ingest.sql',
    params: {
      p_key_hash: FAKE_KEY_HASH, p_id: 'healthcheck', p_parent_id: null,
      p_function: 'healthcheck', p_args: '', p_output: '', p_latency_sec: 0,
      p_error: null, p_timestamp: new Date(0).toISOString(),
      p_input_tokens: 0, p_output_tokens: 0, p_cost_usd: 0,
      p_kind: 'agent', p_agent_id: null, p_agent_name: null,
      p_session_id: null, p_trace_id: null, p_attributes: null,
    } },
  { name: 'insert_agent_event_for_key()', fn: 'insert_agent_event_for_key', fix: '0010_tenant_isolation_ingest.sql',
    params: {
      p_key_hash: FAKE_KEY_HASH, p_id: 'healthcheck', p_agent_id: 'healthcheck',
      p_event_type: 'healthcheck', p_status: 'info', p_agent_name: null,
      p_data: null, p_timestamp: new Date(0).toISOString(),
    } },
  { name: 'insert_regression_run_for_key()', fn: 'insert_regression_run_for_key', fix: '0011_regression_runs.sql',
    params: {
      p_key_hash: FAKE_KEY_HASH, p_run_id: 'healthcheck', p_name: null,
      p_threshold: 0.6, p_version_a_prompt: null, p_version_b_prompt: null,
      p_inputs_count: 0, p_regressions_count: 0, p_duration_sec: 0,
      p_results: [], p_created_at: new Date(0).toISOString(),
    } },
]

export interface HealthDeps {
  url: string
  serviceKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

async function bodyText(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

/**
 * Run all schema checks against a Supabase project. Never throws for
 * expected failure modes — each becomes a failed check entry. Only truly
 * exceptional programmer errors propagate.
 */
export async function checkSchemaHealth(deps: HealthDeps): Promise<SchemaHealth> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 4000
  const base = `${deps.url.replace(/\/+$/, '')}/rest/v1`
  const headers = {
    apikey: deps.serviceKey,
    Authorization: `Bearer ${deps.serviceKey}`,
    'Content-Type': 'application/json',
  }

  const checks: SchemaCheck[] = []

  // ── Reachability ──────────────────────────────────────────────────────
  try {
    const res = await fetchImpl(`${base}/`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    await bodyText(res) // drain
    checks.push({ name: 'Supabase REST reachable', ok: true })
  } catch {
    checks.push({
      name: 'Supabase REST reachable',
      ok: false,
      failure: 'unreachable',
      fix: undefined,
    })
    // Nothing else can work — short-circuit.
    return {
      ok: false,
      checks,
      missingMigrations: [],
      hint:
        'Cannot reach the Supabase REST API. Verify SUPABASE_URL and ' +
        'SUPABASE_SERVICE_KEY, and that the project is not paused.',
    }
  }

  // ── Table / column-group checks ───────────────────────────────────────
  for (const tc of TABLE_CHECKS) {
    const select = tc.columns.join(',')
    try {
      const res = await fetchImpl(`${base}/${tc.table}?select=${select}&limit=0`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) {
        await bodyText(res)
        checks.push({ name: tc.name, ok: true })
        continue
      }
      const text = await bodyText(res)
      const missing =
        /42P01|42703/.test(text) ||
        /(relation|column|table) [^\s]{1,80} does not exist/i.test(text) ||
        /Could not find the .{1,120} in the schema cache/i.test(text)
      checks.push({
        name: tc.name,
        ok: false,
        fix: tc.fix,
        failure: missing ? 'missing' : 'error',
      })
    } catch {
      checks.push({ name: tc.name, ok: false, failure: 'error' })
    }
  }

  // ── RPC signature probes (fake key ⇒ expect 400 'invalid_api_key') ────
  for (const rc of RPC_CHECKS) {
    try {
      const res = await fetchImpl(`${base}/rpc/${rc.fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(rc.params),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await bodyText(res)
      if (/invalid_api_key/.test(text) || /"28000"/.test(text)) {
        // The function exists with the probed signature and rejected our
        // fake key exactly as designed.
        checks.push({ name: rc.name, ok: true })
        continue
      }
      const missing =
        /PGRST20[0-9]/.test(text) || /Could not find the .{1,120} in the schema cache/i.test(text)
      const permission = res.status === 401 || res.status === 403 || /42501/.test(text)
      // res.status 404 on rpc path is also "function not in schema cache".
      checks.push({
        name: rc.name,
        ok: false,
        fix: rc.fix,
        failure: missing || res.status === 404 ? 'missing' : permission ? 'misconfigured' : 'error',
      })
    } catch {
      checks.push({ name: rc.name, ok: false, failure: 'error' })
    }
  }

  const ok = checks.every((c) => c.ok)
  const order = (f: string) => parseInt(f.slice(0, 4), 10)
  const missingMigrations = Array.from(
    new Set(checks.filter((c) => !c.ok && c.fix).map((c) => c.fix as string)),
  ).sort((a, b) => order(a) - order(b))

  return {
    ok,
    checks,
    missingMigrations,
    hint: ok ? undefined : MIGRATION_HINT,
  }
}
