/**
 * PII redaction — TypeScript port of swarmtrace/redact.py.
 *
 * Used by the /api/ingest and /api/events edge routes to scrub PII from
 * args/output/error BEFORE the row hits Supabase. This is defense-in-depth:
 * the SDK already redacts (swarmtrace/redact.py) before sending, but any
 * client that posts directly (curl, MCP, a third-party SDK port) bypasses
 * the SDK. Redacting at the ingest boundary means PII never lands in the
 * DB regardless of which client sent it.
 *
 * Pure functions — no I/O, no global state, no exceptions. Safe to call
 * from the edge hot path.
 *
 * Categories scrubbed (identical to the Python implementation):
 *   1. Emails (RFC-ish local@domain.tld)
 *   2. API-key-shaped strings (sk-, sk-ant-, ghp_, github_pat_, xox[bpoa]-,
 *      AKIA, sk_live_/sk_test_, rk_live_, pypi-AgEI, AIza — with length gates)
 *   3. Credit card numbers (13–19 digit groups, Luhn-checked — NOT bare regex,
 *      so 16-digit trace IDs / UUID fragments pass through)
 *   4. JWTs (eyJ….….… three-segment base64url shape)
 *
 * The regexes and Luhn algorithm are line-for-line ports of redact.py.
 * The Python test suite (tests/test_redact.py, 48 tests) is the source of
 * truth for the contract; the TS test suite (scripts/test-redact.mjs)
 * mirrors the critical cases.
 */

const REDACTED = '[REDACTED]'

// ── Patterns (identical to redact.py) ────────────────────────────────────────

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g

const API_KEY_RE = new RegExp(
  '\\b(' +
    'sk-ant-[A-Za-z0-9_\\-]{20,}' +
    '|sk-[A-Za-z0-9_\\-]{20,}' +
    '|gh[pousr]_[A-Za-z0-9]{36,}' +
    '|github_pat_[A-Za-z0-9_]{82,}' +
    '|xox[bpoa]-[A-Za-z0-9\\-]{10,}' +
    '|AKIA[0-9A-Z]{16}' +
    '|sk_(?:live|test)_[A-Za-z0-9]{24,}' +
    '|rk_live_[A-Za-z0-9]{24,}' +
    '|pypi-AgEI[A-Za-z0-9_\\-]{20,}' +
    '|AIza[0-9A-Za-z_\\-]{35}' +
    ')',
  'g',
)

const JWT_RE = /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g

// Candidate credit card numbers — runs of 13–19 digits with optional
// single space or dash separators. Each candidate is Luhn-checked.
const CC_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g

// ── Luhn check (port of luhn_ok) ────────────────────────────────────────────

export function luhnOk(digits: string): boolean {
  if (!digits || !/^\d+$/.test(digits)) return false
  if (digits.length < 13 || digits.length > 19) return false
  let total = 0
  const parity = digits.length % 2
  for (let i = 0; i < digits.length; i++) {
    let d = parseInt(digits[i], 10)
    if (i % 2 === parity) {
      d *= 2
      if (d > 9) d -= 9
    }
    total += d
  }
  return total % 10 === 0
}

// ── Credit card redactor (Luhn-gated) ───────────────────────────────────────

function redactCreditCards(text: string): string {
  return text.replace(CC_CANDIDATE_RE, (raw) => {
    const digits = raw.replace(/[^0-9]/g, '')
    return luhnOk(digits) ? REDACTED : raw
  })
}

// ── Public entry point ──────────────────────────────────────────────────────

export function redact(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  if (typeof text !== 'string') text = String(text)
  if (text === '') return text
  // Order matters slightly: emails first (so the @ doesn't become part of a
  // JWT-like sequence), then API keys, then JWTs, then credit cards.
  text = text.replace(EMAIL_RE, REDACTED)
  text = text.replace(API_KEY_RE, REDACTED)
  text = text.replace(JWT_RE, REDACTED)
  text = redactCreditCards(text)
  return text
}

/** Split snake/kebab/camel-case keys into normalized words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const SENSITIVE_KEY_WORDS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'authorization', 'auth',
  'cookie', 'session', 'credential', 'otp', 'totp', 'mfa', 'csrf',
  'ssn', 'cvv', 'cvc', 'pin',
])

function isSensitiveKey(key: string): boolean {
  const words = keyWords(key)
  // Length/count metadata is safe and useful even when it describes a secret.
  if (['chars', 'length', 'count', 'size'].includes(words.at(-1) ?? '')) return false
  if (words.some(word => SENSITIVE_KEY_WORDS.has(word))) return true
  const joined = words.join('_')
  return [
    'api_key', 'access_key', 'private_key', 'client_secret',
    'recovery_code', 'backup_code', 'security_answer',
  ].some(part => joined.includes(part))
}

function isUrlKey(key: string): boolean {
  const words = keyWords(key)
  const last = words.at(-1)
  return last === 'url' || last === 'uri' || last === 'href'
}

/** Remove query strings and fragments, which commonly contain credentials. */
export function redactUrl(url: string): string {
  const query = url.indexOf('?')
  const fragment = url.indexOf('#')
  const indexes = [query, fragment].filter(index => index >= 0)
  const cut = indexes.length ? Math.min(...indexes) : url.length
  return url.slice(0, cut)
}

/**
 * Recursively redact strings in an object/array structure.
 *
 * In addition to pattern matching, values under credential-shaped keys are
 * removed contextually and URL-shaped fields lose their query/fragment.
 * Cycles and excessive nesting are replaced with [REDACTED] rather than
 * overflowing the server stack.
 */
export function redactDeep<T>(value: T): T {
  const seen = new WeakSet<object>()
  const MAX_DEPTH = 64

  function walk(current: unknown, depth: number, key?: string): unknown {
    if (depth > MAX_DEPTH) return REDACTED
    if (typeof current === 'string') {
      const text = key && isUrlKey(key) ? redactUrl(current) : current
      return redact(text)
    }
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) return REDACTED

    seen.add(current)
    let result: unknown
    if (Array.isArray(current)) {
      result = current.map(item => walk(item, depth + 1))
    } else {
      const out: Record<string, unknown> = {}
      for (const [childKey, childValue] of Object.entries(current)) {
        const cleaned = isSensitiveKey(childKey)
          ? REDACTED
          : walk(childValue, depth + 1, childKey)
        // Avoid __proto__ assignment changing the result object's prototype.
        Object.defineProperty(out, childKey, {
          value: cleaned,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      result = out
    }
    seen.delete(current)
    return result
  }

  return walk(value, 0) as T
}

const EVENT_VALUE_METHODS = new Set(['fill', 'type', 'press', 'select_option'])

/**
 * Apply schema-aware event redaction after generic deep redaction.
 *
 * This protects direct /api/events clients that do not use the Python SDK:
 * browser value arguments are removed, browser/HTTP URLs are stripped, and
 * streamed token content is never retained chunk-by-chunk.
 */
export function redactEventData(eventType: string, value: unknown): unknown {
  const cleaned = redactDeep(value)
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    cleaned === null || typeof cleaned !== 'object' || Array.isArray(cleaned)
  ) {
    return cleaned
  }

  const raw = value as Record<string, unknown>
  const out = cleaned as Record<string, unknown>
  const method = typeof raw.method === 'string' ? raw.method.toLowerCase() : ''

  if (eventType === 'browser' && Array.isArray(raw.args) && Array.isArray(out.args)) {
    const args = [...out.args]
    if (EVENT_VALUE_METHODS.has(method) && raw.args.length > 1) {
      const rawValue = String(raw.args[1] ?? '')
      args[1] = `[REDACTED(len=${rawValue.length})]`
      if (typeof out.error === 'string' && rawValue) {
        out.error = out.error.replaceAll(rawValue, args[1] as string)
      }
    }
    if (method === 'goto' && typeof raw.args[0] === 'string') {
      args[0] = redactUrl(raw.args[0])
    }
    out.args = args
  }

  if (eventType === 'llm_token') {
    if ('token' in raw) out.token = REDACTED
    if ('accumulated' in raw) out.accumulated = REDACTED
  }

  return out
}
