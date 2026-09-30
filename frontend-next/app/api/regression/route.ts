// /api/regression: prompt-regression runs for the dashboard.
//
// POST (X-API-Key, SDK 0.6.7+ compare(..., report_to_dashboard=True))
//   validates, then calls insert_regression_run_for_key, which stamps the
//   tenant in Postgres from the key hash (migrations 0010/0011).
// GET (Clerk JWT) returns the user's own runs via supaUserRequest + RLS.
//
// The LLM comparison itself runs in the SDK; the dashboard never stores
// provider keys, so only results are reported here.

import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '@/lib/supabase'
import { sha256Hex, createRateLimiter, createIpRateLimiter, createUserRateLimiter, getClientIp } from '@/lib/api-auth'
import { validateRegressionRun } from '@/lib/validate-regression'
// Insert failures are classified like /api/ingest (missing migration 0011
// shows up as PGRST202).
import { classifySupabaseError, ingestErrorBody } from '@/lib/ingest-errors'

const MAX_BODY_BYTES = 1024 * 1024
const SUPA_TIMEOUT_MS = 5000

// Runs are rare (one per prompt comparison), so 60/min per key is plenty.
// The per-IP limiter runs first, as in ingest.
const RATE_LIMIT = 60
const rateLimiter = createRateLimiter({ limit: RATE_LIMIT, prefix: 'st_rl_regression' })
const ipRateLimiter = createIpRateLimiter({ prefix: 'st_ip_rl_regression' })
// GET is a Clerk-authed dashboard read, like /api/agents.
const userRateLimiter = createUserRateLimiter({ prefix: 'st_user_rl_regression' })

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

async function supa(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...((opts.headers as Record<string, string>) || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
  return res
}

async function supaRpc(fn: string, params: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase RPC ${fn} ${res.status}: ${text}`)
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) return jsonResponse(401, { error: 'Missing X-API-Key header' })

  let bodyBytes: ArrayBuffer
  try { bodyBytes = await req.arrayBuffer() }
  catch { return jsonResponse(400, { error: 'Could not read request body' }) }
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Payload too large' })

  try {
    const keyHash = await sha256Hex(apiKey)

    // Per-IP limit first, so rotating fake keys doesn't buy fresh buckets
    const clientIp = getClientIp(req)
    if (!await ipRateLimiter.check(clientIp)) {
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': '60', 'X-RateLimit-Scope': 'ip' },
      })
    }

    // Per-key rate limit, before the DB lookup
    if (!await rateLimiter.check(keyHash)) {
      return new Response(null, {
        status: 429,
        headers: {
          'Retry-After': '60',
          'X-RateLimit-Limit':  String(RATE_LIMIT),
          'X-RateLimit-Window': '60s',
        },
      })
    }

    // Tenant isolation is in Postgres (migration 0011):
    // insert_regression_run_for_key resolves key_hash to user_id itself. The
    // probe is so revoked/unknown keys get a 401 instead of an RPC 500.
    const keyRes = await supa(
      `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`,
      { headers: { Prefer: 'return=representation' } }
    )
    const keyRows: Array<{ user_id: string }> = await keyRes.json()
    if (!keyRows || keyRows.length === 0)
      return jsonResponse(401, { error: 'Invalid or revoked API key' })

    let payload: unknown
    try { payload = JSON.parse(new TextDecoder().decode(bodyBytes)) }
    catch { return jsonResponse(400, { error: 'Body must be valid JSON' }) }

    const { run, error } = validateRegressionRun(payload)
    if (!run) {
      return jsonResponse(400, {
        error: error!.error,
        ...(error!.index !== undefined ? { index: error!.index } : {}),
      })
    }

    await supaRpc('insert_regression_run_for_key', {
      p_key_hash:          keyHash,
      p_run_id:            run.run_id,
      p_name:              run.name,
      p_threshold:         run.threshold,
      p_version_a_prompt:  run.version_a_prompt,
      p_version_b_prompt:  run.version_b_prompt,
      p_inputs_count:      run.inputs_count,
      p_regressions_count: run.regressions_count,
      p_duration_sec:      run.duration_sec,
      p_results:           JSON.stringify(run.results),
    })

    // 204 on success, including a retried POST of an already-reported
    // run_id (no-op in the RPC).
    return new Response(null, { status: 204 })
  } catch (err) {
    const classified = classifySupabaseError(err)
    console.error('[api/regression] POST failed:', classified.code, err)
    return jsonResponse(500, ingestErrorBody(classified))
  }
}

export interface RegressionRunRow {
  id: string
  run_id: string
  name: string | null
  threshold: number
  version_a_prompt: string | null
  version_b_prompt: string | null
  inputs_count: number
  regressions_count: number
  duration_sec: number
  results: unknown[]
  created_at: string
}

export async function GET(request: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await userRateLimiter.check(userId)) return jsonResponse(429, { error: 'Too many requests' })

  try {
    // RLS is enforced via the user's Clerk JWT; the user_id filter in the
    // URL is a second guard, same as /api/agents.
    const url = new URL(request.url)
    const limitParam = url.searchParams.get('limit')
    const limit = Math.min(100, Math.max(1, Number(limitParam) || 50))

    const rows = (await supaUserRequest(
      `regression_runs?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`,
      userId
    )) as RegressionRunRow[]

    return NextResponse.json({
      runs: rows,
      // true when we hit the row cap, so the client can say "most recent N"
      truncated: rows.length >= limit,
    })
  } catch (error) {
    if (error instanceof RlsEnforcementError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[api/regression] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
