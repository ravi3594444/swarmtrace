/**
 * Startup health check — validates that the environment is correctly
 * configured for RLS enforcement before the app starts serving traffic.
 *
 * In production, a missing Clerk↔Supabase integration prerequisite (no
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, or Clerk not configured) means supaUserRequest
 * will throw RlsEnforcementError on every request — every dashboard page 401s.
 * This module surfaces that misconfiguration LOUDLY at startup instead of
 * letting the user discover it one 401 at a time.
 *
 * Usage: import once at the top of app/layout.tsx (or any server entry point)
 * so the check runs at module load. It logs warnings but never throws — a
 * misconfigured dev environment shouldn't block the build.
 *
 * The check is a no-op in test environments (NODE_ENV === 'test') so unit
 * tests don't need to stub env vars.
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

/**
 * Run the health check and return the result. Also logs warnings to console.
 * Safe to call multiple times — pure function over process.env.
 */
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

  // Check Clerk env vars (only warn — Clerk middleware will catch missing keys).
  for (const key of REQUIRED_FOR_CLERK) {
    if (!process.env[key]) {
      warnings.push(`${key} is not set — Clerk auth will not work.`)
    }
  }

  // In production, a missing anon key means RLS can't be enforced and
  // supaUserRequest will throw on every request. This is a BLOCKER for
  // production — surface it as a loud error, not a warning.
  if (nodeEnv === 'production' && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    warnings.push(
      '⚠️  NEXT_PUBLIC_SUPABASE_ANON_KEY is missing in production. ' +
      'supaUserRequest will throw RlsEnforcementError on every request — ' +
      'every dashboard page will 401. Either set the anon key or explicitly ' +
      'set SUPABASE_RLS_FALLBACK=1 (NOT recommended — bypasses RLS).'
    )
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

  // Log warnings (never throw — don't block the build).
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

// Run once at module load in non-test environments.
if (process.env.NODE_ENV !== 'test') {
  runHealthCheck()
}
