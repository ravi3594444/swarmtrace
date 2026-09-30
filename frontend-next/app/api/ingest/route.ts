// Node.js runtime: DecompressionStream (used for gzip batches) isn't
// available on the Edge runtime.

// sha256 and the rate limiter live in lib/api-auth.ts, shared with
// /api/events and /api/mcp.
import { sha256Hex, createRateLimiter, createIpRateLimiter, getClientIp } from '@/lib/api-auth'
// DB failures after validation are classified (lib/ingest-errors.ts) so
// "run the migrations" is distinguishable from "Supabase is down".
import { classifySupabaseError, ingestErrorBody } from '@/lib/ingest-errors'

const MAX_BODY_BYTES  = 1024 * 1024
const MAX_BATCH_SIZE = 50
const SUPA_TIMEOUT_MS = 5000

const RATE_LIMIT = 120
const rateLimiter = createRateLimiter({ limit: RATE_LIMIT, prefix: 'st_rl' })
// Per-IP limiter runs before the per-key one, so rotating fake API keys
// doesn't help. See lib/api-auth.ts.
const ipRateLimiter = createIpRateLimiter({ prefix: 'st_ip_rl_ingest' })

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

// Validation lives in lib/validate-ingest.ts so it can be unit-tested.
import { validateIngest, decodeIngestBody, type TraceRow } from '@/lib/validate-ingest'

export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) return jsonResponse(401, { error: 'Missing X-API-Key header' })

  // Read the actual bytes, Content-Length is client-supplied and optional.
  let bodyBytes: ArrayBuffer
  try { bodyBytes = await req.arrayBuffer() }
  catch { return jsonResponse(400, { error: 'Could not read request body' }) }
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Payload too large' })

  try {
    const keyHash = await sha256Hex(apiKey)

    // Per-IP limit first, so rotating fake keys doesn't buy fresh buckets.
    const clientIp = getClientIp(req)
    if (!await ipRateLimiter.check(clientIp)) {
      return new Response(null, {
        status: 429,
        headers: {
          'Retry-After': '60',
          'X-RateLimit-Scope': 'ip',
        },
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

    // Tenant isolation is enforced in Postgres (migration 0010):
    // upsert_trace_for_key resolves key_hash to user_id itself. We still probe
    // for the key here so revoked/unknown keys get a 401 rather than an RPC 500.
    let keyRows: Array<{ user_id: string }>
    try {
      const keyRes = await supa(
        `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`,
        { headers: { Prefer: 'return=representation' } }
      )
      keyRows = await keyRes.json()
    } catch (err) {
      // A failing probe (api_keys table missing, Supabase down) isn't an
      // auth failure, so classify it instead of returning 401.
      const classified = classifySupabaseError(err)
      console.error('[api/ingest] API-key lookup failed:', classified.code, err)
      return jsonResponse(500, ingestErrorBody(classified))
    }
    if (!keyRows || keyRows.length === 0)
      return jsonResponse(401, { error: 'Invalid or revoked API key' })

    // Batches arrive gzipped; the runtime doesn't inflate request bodies, so
    // do it here with a decompressed-size bound before parsing.
    let payload: unknown
    try {
      payload = JSON.parse(await decodeIngestBody(bodyBytes, req.headers.get('content-encoding')))
    } catch { return jsonResponse(400, { error: 'Body must be valid JSON (gzip supported via Content-Encoding: gzip)' }) }

    const { rows, error } = validateIngest(payload)
    if (!rows) return jsonResponse(400, error)

    // Cap batch size: 50 traces is normal, 5000 is a runaway SDK. Keeps RPC
    // latency bounded.
    if (rows.length > MAX_BATCH_SIZE) {
      return jsonResponse(413, {
        error: `Batch too large: ${rows.length} traces (max ${MAX_BATCH_SIZE}). Split into smaller batches.`,
      })
    }

    // One RPC per trace. Each supaRpc call is its own transaction, so if row
    // K fails, rows 1..K-1 are already committed while we return 500. That's
    // safe because upsert_trace_with_metrics is idempotent per row and the SDK
    // retries the whole batch. Any future real batch RPC has to keep that
    // idempotency, or retries will double-count metrics.
    try {
      for (const row of rows as TraceRow[]) {
        // tenant is stamped inside Postgres from p_key_hash
        await supaRpc('upsert_trace_for_key', {
          p_key_hash:      keyHash,
          p_id:            row.id,
          p_parent_id:     row.parent_id ?? null,
          p_trace_id:      row.trace_id ?? row.id,
          p_function:      row.function,
          p_args:          row.args,
          p_output:        row.output,
          p_latency_sec:   row.latency_sec,
          p_error:         row.error ?? null,
          p_timestamp:     row.timestamp,
          p_input_tokens:  row.input_tokens,
          p_output_tokens: row.output_tokens,
          p_cost_usd:      row.cost_usd,
          p_kind:          row.kind,
          p_agent_id:      row.agent_id,
          p_agent_name:    row.agent_name,
          p_session_id:    row.session_id ?? null,
          p_attributes:    row.attributes ?? null,
        })
      }
      // last_used is updated inside upsert_trace_for_key.
    } catch (err) {
      // Usually the project was never migrated past 0000, so
      // upsert_trace_for_key is missing and PostgREST answers PGRST202.
      // Classify and hint; the full error only goes to server logs.
      const classified = classifySupabaseError(err)
      console.error('[api/ingest] trace write failed:', classified.code, err)
      return jsonResponse(500, ingestErrorBody(classified))
    }

    return new Response(null, { status: 204 })
  } catch (err) {
    // Backstop for anything outside the two classified stages (rate-limit
    // store errors, unexpected bugs); still classified.
    const classified = classifySupabaseError(err)
    console.error('[api/ingest] request failed:', classified.code, err)
    return jsonResponse(500, ingestErrorBody(classified))
  }
}
