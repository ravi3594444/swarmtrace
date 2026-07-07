/**
 * Test: text similarity + line diff used by the Compare view.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { similarity, lineDiff } from '../lib/text-compare.ts'

describe('similarity', () => {
  test('identical strings score 1.0', () => {
    assert.equal(similarity('the quick brown fox', 'the quick brown fox'), 1.0)
  })

  test('two empty strings are treated as identical', () => {
    assert.equal(similarity('', ''), 1.0)
  })

  test('one empty string scores 0.0', () => {
    assert.equal(similarity('hello world', ''), 0.0)
  })

  test('completely different text scores near 0', () => {
    assert.ok(similarity('alpha beta gamma', 'red green blue') < 0.2)
  })

  test('partially overlapping text scores in between', () => {
    const s = similarity('the quick brown fox', 'the quick red fox')
    assert.ok(s > 0.2 && s < 1.0)
  })

  test('is symmetric', () => {
    const a = similarity('one two three four', 'one two four five')
    const b = similarity('one two four five', 'one two three four')
    assert.equal(a, b)
  })
})

describe('lineDiff', () => {
  test('marks unchanged lines as same', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc')
    assert.deepEqual(d.map((l) => l.type), ['same', 'same', 'same'])
  })

  test('detects added and removed lines', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\nc')
    const types = d.map((l) => l.type)
    assert.ok(types.includes('removed'))
    assert.ok(types.includes('added'))
    assert.ok(types.includes('same'))
  })
})
