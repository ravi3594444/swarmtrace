// Runs on the Node.js runtime (Vercel's default). DecompressionStream, used
// by decodeIngestBody() below for gzip-batched payloads, is not supported on
// Vercel's Edge runtime (confirmed via build: "A Node.js API is used
// (DecompressionStream) which is not supported in the Edge Runtime") — it
// would throw on every gzip-compressed batch send. Vercel also deprecated
// standalone Edge Functions in June 2025 in favor of Node.js/Fluid compute,
// which has full Web API + npm support, so there's no upside to staying on
// 'edge' here.

// sha256 + rate limiter live in lib/api-auth.ts so they can be shared
// with /api/events and /api/mcp without copy-paste drift.
import { sha256Hex, createRateLimiter, createIpRateLimiter, getClientIp } from '@/lib/api-auth'
// Post-validation DB failures used to collapse into an opaque
// "Internal server error" 500; classify them so the operator (and the
// SDK, which now surfaces the response body) can tell "run the
// migrations" apart from "Supabase is down". See lib/ingest-errors.ts.
import { classifySupabaseError, ingestErrorBody } from '@/lib/ingest-errors'

const MAX_BODY_BYTES  = 1024 * 1024
const MAX_BATCH_SIZE = 50
const SUPA_TIMEOUT_MS = 5000

const RATE_LIMIT = 120
const rateLimiter = createRateLimiter({ limit: RATE_LIMIT, prefix: 'st_rl' })
// Per-IP limiter runs BEFORE the per-key limiter — caps attackers who
// rotate fake API keys (each key would get its own per-key bucket, but
// they all share the per-IP bucket). 600/60s is 10x the per-key ingest
// limit, so legitimate single-source workloads (the SDK's ~30/min per
// active traced process) never hit it. See lib/api-auth.ts for the full
// reasoning.
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

// Validation logic lives in lib/validate-ingest.ts so it can be unit-tested
// without standing up the edge runtime. The route imports the shape-detector
// + validator; tests import the same functions directly.
import { validateIngest, decodeIngestBody, type TraceRow } from '@/lib/validate-ingest'

export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) return jsonResponse(401, { error: 'Missing X-API-Key header' })

  // Read the actual bytes — Content-Length is client-supplied and optional,
  // so checking the header alone can be bypassed by omitting it entirely.
  let bodyBytes: ArrayBuffer
  try { bodyBytes = await req.arrayBuffer() }
  catch { return jsonResponse(400, { error: 'Could not read request body' }) }
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Payload too large' })

  try {
    const keyHash = await sha256Hex(apiKey)

    // ── Per-IP rate limit (BEFORE per-key — caps key-rotation attacks) ────
    // An attacker rotating fake API keys gets a fresh per-key bucket for
    // each key but shares one per-IP bucket, so the IP limit catches them
    // before the per-key limiter or the Supabase lookup ever runs. See
    // lib/api-auth.ts::createIpRateLimiter for the full reasoning.
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

    // ── Per-key rate limit check (before DB lookup — cheap, fast) ─────────
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

    // Tenant isolation is enforced inside Postgres (migration 0010):
    // upsert_trace_for_key resolves key_hash → user_id via a SECURITY
    // DEFINER helper and stamps user_id itself. The app never chooses
    // the tenant id for the write path, so a buggy or compromised
    // service-role caller cannot insert under an arbitrary user_id.
    // We still do a cheap existence probe here so revoked/unknown keys
    // return 401 (not a 500 from the RPC) before we parse the body.
    let keyRows: Array<{ user_id: string }>
    try {
      const keyRes = await supa(
        `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`,
        { headers: { Prefer: 'return=representation' } }
      )
      keyRows = await keyRes.json()
    } catch (err) {
      // The probe failing (e.g. api_keys table missing because migration
      // 0000 was never applied, or Supabase down) is NOT an auth failure —
      // don't return 401 for it. Classify so the operator gets the fix.
      const classified = classifySupabaseError(err)
      console.error('[api/ingest] API-key lookup failed:', classified.code, err)
      return jsonResponse(500, ingestErrorBody(classified))
    }
    if (!keyRows || keyRows.length === 0)
      return jsonResponse(401, { error: 'Invalid or revoked API key' })

    // The SDK's batch path gzips the body and sets Content-Encoding: gzip.
    // Request bodies are NOT auto-decompressed by the runtime, so inflate
    // explicitly (with a decompressed-size bound) before JSON-parsing.
    let payload: unknown
    try {
      payload = JSON.parse(await decodeIngestBody(bodyBytes, req.headers.get('content-encoding')))
    } catch { return jsonResponse(400, { error: 'Body must be valid JSON (gzip supported via Content-Encoding: gzip)' }) }

    const { rows, error } = validateIngest(payload)
    if (!rows) return jsonResponse(400, error)

    // Cap batch size — a single POST with 50 traces is fine; 5000 is a
    // runaway SDK or a misuse. Rejecting early keeps Supabase RPC latency
    // bounded and prevents one fat batch from starving other users.
    if (rows.length > MAX_BATCH_SIZE) {
      return jsonResponse(413, {
        error: `Batch too large: ${rows.length} traces (max ${MAX_BATCH_SIZE}). Split into smaller batches.`,
      })
    }

    // ── Insert each trace via the atomic upsert+metrics RPC ───────────────
    // One RPC per trace (not one per batch) because the RPC is itself atomic
    // per-row (ON CONFLICT DO UPDATE + conditional metrics increment). A
    // batch RPC would be a future optimization, but the current shape keeps
    // the migration surface small and the retry semantics identical to the
    // single-object path — if the batch fails mid-way, the SDK retries the
    // whole batch and every row is idempotent.
    //
    // On a confirmed-successful insert, the SDK marks the row synced=1 in
    // its local SQLite DB (task 3). If this whole batch RPC sequence fails,
    // the SDK leaves all rows synced=0 and the resync CLI replays them.
    //
    // TRANSACTION SEMANTICS (audit finding #5 — spelling this out
    // explicitly since it's easy to assume otherwise from the loop shape):
    // this `for` loop is NOT wrapped in a single database transaction.
    // Each `supaRpc` call is its own independent Postgres transaction. If
    // row K throws (network blip, constraint violation, Supabase 5xx),
    // rows 1..K-1 in this batch are ALREADY DURABLY COMMITTED even though
    // this whole HTTP request goes on to return 500 below. This is safe
    // ONLY because `upsert_trace_with_metrics` is idempotent per-row (ON
    // CONFLICT DO UPDATE) — the SDK's retry-the-whole-batch-on-any-failure
    // strategy re-sends rows 1..K-1 too, and re-upserting an
    // already-committed row is a no-op for `traces` and must stay a no-op
    // for whatever conditional metrics increment runs alongside it (see
    // the RPC's own SQL for how it avoids double-counting on a re-upsert
    // of the same id).
    //
    // If this loop is ever replaced with a real multi-row batch RPC
    // wrapped in one transaction, that RPC MUST preserve per-row
    // idempotency under retry — either by keeping the same ON CONFLICT
    // semantics per row inside the batch, or by making the whole batch
    // idempotent as a unit (e.g. keyed by a batch id). Silently dropping
    // idempotency in a "faster" batch RPC would turn a currently-safe
    // retry into duplicate metrics on every retried batch.
    try {
      for (const row of rows as TraceRow[]) {
        // p_key_hash (not p_user_id) — tenant stamped inside Postgres.
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
      // THE classic production failure: the Supabase project was never
      // migrated past 0000, so upsert_trace_for_key doesn't exist and
      // PostgREST answers PGRST202 on every batch. Previously this
      // surfaced as an opaque 500 ("valid key, zero traces, no hints").
      // Classify + hint; full error goes to the server logs only.
      const classified = classifySupabaseError(err)
      console.error('[api/ingest] trace write failed:', classified.code, err)
      return jsonResponse(500, ingestErrorBody(classified))
    }

    return new Response(null, { status: 204 })
  } catch (err) {
    // Backstop for anything outside the two classified stages above
    // (rate-limit store errors, unexpected bugs). Still classified, so
    // even the generic path never returns a naked "Internal server error".
    const classified = classifySupabaseError(err)
    console.error('[api/ingest] request failed:', classified.code, err)
    return jsonResponse(500, ingestErrorBody(classified))
  }
}
