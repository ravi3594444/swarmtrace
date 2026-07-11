/**
 * Test: Supabase traces-query builder (lib/trace-query.ts).
 *
 * Covers the bug fixed in this commit (audit finding #4):
 * /api/agents used to apply the `since` (date-range) filter CLIENT-SIDE
 * in JS, AFTER fetching the 500 most-recent traces from Supabase. So if
 * a user had >500 traces total, anything older than the 500th-most-recent
 * was never fetched from the DB at all — regardless of which time range
 * they selected. The fix pushes `since` into the Supabase query as
 * `&timestamp=gte.<iso>` so the DB applies the filter BEFORE the limit.
 *
 * These tests verify the query-construction contract directly. The
 * integration (route-level) test would require standing up Next.js +
 * Supabase — out of scope for the node:test runner. The behavior under
 * test is the unit that the bug lived in: the URL string handed to
 * supaUserRequest.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTracesQuery,
  parseSinceParam,
  parseBeforeParam,
  isTruncated,
  DEFAULT_TRACE_LIMIT,
} from '../lib/trace-query.ts'

// ── buildTracesQuery ───────────────────────────────────────────────────────

describe('buildTracesQuery', () => {
  test('base query: user_id + order + default limit', () => {
    const q = buildTracesQuery('user-123')
    assert.match(q, /^traces\?user_id=eq\.user-123&order=timestamp\.desc&limit=500$/)
  })

  test('user_id is URL-encoded (defence-in-depth — RLS is the real guard)', () => {
    const q = buildTracesQuery('user|with|pipes')
    assert.match(q, /user_id=eq\.user%7Cwith%7Cpipes/)
  })

  test('explicit limit overrides default', () => {
    const q = buildTracesQuery('u', { limit: 50 })
    assert.match(q, /limit=50$/)
  })

  test('limit of 0 or negative falls back to default (no malformed query)', () => {
    assert.match(buildTracesQuery('u', { limit: 0 }), /limit=500$/)
    assert.match(buildTracesQuery('u', { limit: -1 }), /limit=500$/)
  })

  test('since is pushed into the DB query as &timestamp=gte.<iso> (THE fix for #4)', () => {
    // The bug: this filter used to be applied in JS AFTER the 500-row fetch.
    // The fix: it goes into the URL so Supabase filters BEFORE the limit.
    const since = Date.parse('2025-01-15T00:00:00.000Z')
    const q = buildTracesQuery('u', { since })
    // ISO 8601, URL-encoded (colons become %3A).
    assert.match(q, /&timestamp=gte\.\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}\.\d{3}Z/)
    // Specifically: the date portion must be the one we passed.
    assert.match(q, /timestamp=gte\.2025-01-15T00%3A00%3A00\.000Z/)
  })

  test('since = 0 is treated as "valid, filter from epoch" (not skipped as falsy)', () => {
    // Important: Number.isFinite(0) is true, so this should produce a filter.
    // A naive `if (since)` check would skip it — that's the kind of bug
    // these tests guard against.
    const q = buildTracesQuery('u', { since: 0 })
    assert.match(q, /timestamp=gte\./)
  })

  test('since = null/undefined does NOT add a filter (All Time)', () => {
    assert.doesNotMatch(buildTracesQuery('u', { since: undefined }), /timestamp=gte/)
    assert.doesNotMatch(buildTracesQuery('u', { since: null }), /timestamp=gte/)
  })

  test('since = NaN does NOT add a filter (graceful fallback)', () => {
    // parseSinceParam already rejects NaN, but buildTracesQuery should
    // also be defensive — never produce a malformed query string.
    assert.doesNotMatch(buildTracesQuery('u', { since: NaN }), /timestamp=gte/)
  })

  test('before is pushed into the DB query as &timestamp=lt.<iso> (cursor pagination)', () => {
    const q = buildTracesQuery('u', { before: '2025-01-15T00:00:00.000Z' })
    assert.match(q, /&timestamp=lt\.2025-01-15T00%3A00%3A00\.000Z/)
  })

  test('before = null/undefined does NOT add a filter', () => {
    assert.doesNotMatch(buildTracesQuery('u', { before: undefined }), /timestamp=lt/)
    assert.doesNotMatch(buildTracesQuery('u', { before: null }), /timestamp=lt/)
  })

  test('since + before combine correctly (windowed query)', () => {
    const q = buildTracesQuery('u', {
      since: Date.parse('2025-01-10T00:00:00.000Z'),
      before: '2025-01-15T00:00:00.000Z',
    })
    assert.match(q, /timestamp=gte\.2025-01-10T00%3A00%3A00\.000Z/)
    assert.match(q, /timestamp=lt\.2025-01-15T00%3A00%3A00\.000Z/)
  })

  test('order of clauses is stable (user_id, order, limit, since, before)', () => {
    // Stable order = easier to assert against in integration tests + logs.
    const q = buildTracesQuery('user-1', {
      since: 1000,
      before: '2025-01-01T00:00:00.000Z',
    })
    const userIdIdx = q.indexOf('user_id=')
    const orderIdx  = q.indexOf('order=')
    const limitIdx  = q.indexOf('limit=')
    const sinceIdx  = q.indexOf('timestamp=gte')
    const beforeIdx = q.indexOf('timestamp=lt')
    assert.ok(userIdIdx < orderIdx, 'user_id should come before order')
    assert.ok(orderIdx  < limitIdx, 'order should come before limit')
    assert.ok(limitIdx  < sinceIdx, 'limit should come before since')
    assert.ok(sinceIdx  < beforeIdx, 'since should come before before')
  })
})

// ── parseSinceParam ────────────────────────────────────────────────────────

describe('parseSinceParam', () => {
  test('parses epoch ms from ?since=<num>', () => {
    const ms = Date.parse('2025-01-15T00:00:00.000Z')
    assert.equal(parseSinceParam(`https://x/api/agents?since=${ms}`), ms)
  })

  test('returns null when since is missing', () => {
    assert.equal(parseSinceParam('https://x/api/agents'), null)
    assert.equal(parseSinceParam('https://x/api/agents?other=1'), null)
  })

  test('returns null for non-numeric since', () => {
    assert.equal(parseSinceParam('https://x/api/agents?since=abc'), null)
  })

  test('returns null for empty-string since (Number("") === 0 — must NOT be treated as filter)', () => {
    // Edge case caught by this test in the first iteration: a naive
    // `Number(sinceParam)` would convert "" to 0, which is a valid epoch,
    // and the route would silently filter to "since 1970". Treat empty
    // string as "no filter" — same as missing.
    assert.equal(parseSinceParam('https://x/api/agents?since='), null)
  })

  test('parses since=0 as 0 (not null — All Time would be wrong)', () => {
    // Same falsy-guard as buildTracesQuery — 0 is a valid epoch.
    assert.equal(parseSinceParam('https://x/api/agents?since=0'), 0)
  })
})

// ── parseBeforeParam ───────────────────────────────────────────────────────

describe('parseBeforeParam', () => {
  test('parses ISO 8601 timestamp from ?before=<iso>', () => {
    const iso = '2025-01-15T00:00:00.000Z'
    assert.equal(parseBeforeParam(`https://x/api/traces?before=${iso}`), iso)
  })

  test('returns null when before is missing', () => {
    assert.equal(parseBeforeParam('https://x/api/traces'), null)
  })

  test('returns null for non-date strings (no garbage to Supabase)', () => {
    assert.equal(parseBeforeParam('https://x/api/traces?before=not-a-date'), null)
    assert.equal(parseBeforeParam('https://x/api/traces?before='), null)
  })
})

// ── isTruncated ────────────────────────────────────────────────────────────

describe('isTruncated', () => {
  test('returns true when rows.length equals the limit (cap hit)', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i }))
    assert.equal(isTruncated(rows), true)
  })

  test('returns true when rows.length exceeds the limit (should not happen, but defensive)', () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: i }))
    assert.equal(isTruncated(rows), true)
  })

  test('returns false when rows.length is below the limit', () => {
    const rows = Array.from({ length: 499 }, (_, i) => ({ id: i }))
    assert.equal(isTruncated(rows), false)
  })

  test('returns false for empty rows', () => {
    assert.equal(isTruncated([]), false)
  })

  test('returns false for non-array input (defensive)', () => {
    // Cast through unknown — the route guards against this never happening,
    // but isTruncated should not throw if it ever does.
    assert.equal(isTruncated(/** @type {unknown[]} */ (null)), false)
    assert.equal(isTruncated(/** @type {unknown[]} */ (undefined)), false)
  })

  test('respects custom limit', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }))
    assert.equal(isTruncated(rows, 50), true)
    assert.equal(isTruncated(rows, 100), false)
  })

  test('DEFAULT_TRACE_LIMIT is 500 (sanity check — matches prior hard-coded value)', () => {
    assert.equal(DEFAULT_TRACE_LIMIT, 500)
  })
})
