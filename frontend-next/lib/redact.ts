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
