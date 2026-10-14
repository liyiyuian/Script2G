// Layout tests: wrapping speed and correctness, output parts, byte-limited labels.  `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTextWidth } from '@evenrealities/pretext'
import { INNER, MAX_CHARS, PART_CHARS, fitBytes, toParts, wrap } from '../src/layout.ts'

test('a long word with no spaces wraps quickly, every line fits, nothing is lost', () => {
  const word = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, ok: true }))) // ~15,000 chars, no spaces
  const t0 = performance.now()
  const lines = wrap(word)
  const ms = performance.now() - t0
  assert.ok(ms < 1000, `took ${Math.round(ms)} ms`) // the old routine took minutes
  assert.equal(lines.join(''), word)
  for (const l of lines) assert.ok(getTextWidth(l) <= INNER, l)
})

test('ordinary text wraps at word boundaries within the width', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
  const lines = wrap(text)
  for (const l of lines) assert.ok(getTextWidth(l) <= INNER)
  assert.equal(lines.join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim())
})

test('parts fit one text box, are never empty, and huge output is cut and says so', () => {
  assert.deepEqual(toParts(''), [' '])
  const parts = toParts(Array.from({ length: 200 }, (_, i) => `Line ${i}: some text`).join('\n'))
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(p.length <= PART_CHARS && p.length > 0)
  const huge = toParts('x '.repeat(MAX_CHARS))
  assert.match(huge[huge.length - 1], /cut: longer than the glasses can show/)
})

test('fitBytes keeps whole characters (never half an emoji)', () => {
  const s = fitBytes('a'.repeat(29) + '😀b', 32)
  assert.equal(s, 'a'.repeat(29))
  assert.equal(fitBytes('Weather ☀ today', 32), 'Weather ☀ today')
})
