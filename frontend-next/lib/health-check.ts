/**
 * Startup env check for RLS enforcement. In production a missing
 * NEXT_PUBLIC_SUPABASE_ANON_KEY or Clerk setup makes every supaUserRequest
 * throw, so every dashboard page 401s; this logs that at startup. Import once
 * from app/layout.tsx. It warns but never throws, and does nothing when
 * NODE_ENV is 'test'.
 */

const REQUIRED_FOR_RLS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const

const REQUIRED_FOR_CLERK = [
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
] as const

export interface HealthCheckResult {
  ok: boolean
  missing: string[]
  warnings: string[]
}

/** Run the health check, log warnings and return the result. Safe to call repeatedly. */
export function runHealthCheck(): HealthCheckResult {
  const missing: string[] = []
  const warnings: string[] = []
  const nodeEnv = process.env.NODE_ENV || 'development'

  // Check Supabase env vars.
  for (const key of REQUIRED_FOR_RLS) {
    if (!process.env[key]) {
      missing.push(key)
    }
  }

  // Check Clerk env vars (warn only, Clerk middleware catches missing keys).
  for (const key of REQUIRED_FOR_CLERK) {
    if (!process.env[key]) {
      warnings.push(`${key} is not set — Clerk auth will not work.`)
    }
  }

  // In production a missing anon key means RLS can't be enforced and
  // supaUserRequest throws on every request, so log it as an error.
  if (nodeEnv === 'production' && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    warnings.push(
      '⚠️  NEXT_PUBLIC_SUPABASE_ANON_KEY is missing in production. ' +
      'supaUserRequest will throw RlsEnforcementError on every request — ' +
      'every dashboard page will 401. Either set the anon key or explicitly ' +
      'set SUPABASE_RLS_FALLBACK=1 (NOT recommended — bypasses RLS).'
    )
  }

  // Upstash is needed for distributed rate limiting in production.
  if (nodeEnv === 'production') {
    const hasUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
    if (!hasUpstash && process.env.SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT !== '1') {
      warnings.push(
        '⚠️  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing in production. ' +
        'Rate limiters fail closed (429) until Upstash is configured, or until ' +
        'SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT=1 is set (weak per-isolate fallback).'
      )
    } else if (!hasUpstash) {
      warnings.push(
        '⚠️  SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT=1 is set without Upstash — rate limits ' +
        'are per-isolate only and scale with the number of warm serverless instances.'
      )
    }
  }

  // In production with fallback forced on, warn that RLS is being bypassed.
  if (nodeEnv === 'production' && process.env.SUPABASE_RLS_FALLBACK === '1') {
    warnings.push(
      '⚠️  SUPABASE_RLS_FALLBACK=1 is set in production. supaUserRequest will ' +
      'silently fall back to the service-role key when Clerk JWT is unavailable, ' +
      'bypassing RLS. This is an emergency escape hatch — remove it as soon as ' +
      'the Clerk↔Supabase integration is configured.'
    )
  }

  // log warnings, never throw
  for (const w of warnings) {
    console.warn(`[health-check] ${w}`)
  }
  if (missing.length > 0) {
    console.error(
      `[health-check] Missing required env vars: ${missing.join(', ')}. ` +
      `The app will not function correctly without these.`
    )
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
  }
}

// run once at module load outside tests
if (process.env.NODE_ENV !== 'test') {
  runHealthCheck()
}
