/**
 * PII redaction, a TypeScript port of swarmtrace/redact.py. Scrubs
 * args/output/error in /api/ingest and /api/events before the row reaches
 * Supabase, since clients posting directly skip the SDK's own redaction.
 *
 * Scrubs emails, API-key-shaped strings, Luhn-valid card numbers (so 16-digit
 * trace IDs pass through) and JWTs. Pure functions, no I/O. The regexes
 * mirror the Python ones; scripts/test-redact.mjs covers the main cases.
 */

const REDACTED = '[REDACTED]'


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

// Candidate card numbers: 13-19 digits with optional single space/dash
// separators, each Luhn-checked.
const CC_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g


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


function redactCreditCards(text: string): string {
  return text.replace(CC_CANDIDATE_RE, (raw) => {
    const digits = raw.replace(/[^0-9]/g, '')
    return luhnOk(digits) ? REDACTED : raw
  })
}


export function redact(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  if (typeof text !== 'string') text = String(text)
  if (text === '') return text
  // emails first so the @ doesn't end up inside a JWT-like sequence
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
  // length/count metadata is safe even when it describes a secret
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
 * Recursively redact strings in an object/array. Values under
 * credential-shaped keys are removed, URL fields lose their query/fragment,
 * and cycles or deep nesting become [REDACTED].
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
        // don't let __proto__ assignment change the result's prototype
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

/** Schema-aware event redaction, run after the generic deep redaction: drops browser value args, strips URLs and never keeps streamed token content. */
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
