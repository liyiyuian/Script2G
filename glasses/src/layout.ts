// Text layout for the glasses: lines measured with the firmware font, output split into parts that one
// firmware-scrolled text box can hold, and labels cut to a byte budget. No SDK here, so Node tests can run it.
import { getTextWidth } from '@evenrealities/pretext'

export const W = 576
export const PAD = 4
export const INNER = W - 2 * PAD
// A text box the glasses scroll themselves holds about 1000 characters (rebuild limit; the simulator refused
// a 1390-character update), so longer output is split into parts of up to PART_CHARS.
export const PART_CHARS = 950
// More than the glasses can usefully show; longer output is cut, and says so.
export const MAX_CHARS = 20_000

/** Characters of `s` (at least 1) that fit in maxPx. Searches a window, since a line holds far fewer than
 * 400 characters: measuring the whole of a long unbroken word each time made wrapping take minutes. */
function fit(s: string, maxPx: number): number {
  const w = s.slice(0, 400)
  let lo = 1
  let hi = w.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (getTextWidth(w.slice(0, mid)) <= maxPx) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Splits text into display lines at word boundaries, measured with the firmware font. */
export function wrap(text: string, maxPx = INNER): string[] {
  const out: string[] = []
  for (const para of text.replace(/\t/g, '  ').split('\n')) {
    let line = ''
    for (const token of para.split(/(\s+)/).filter(Boolean)) {
      if (line.length + token.length < 400 && getTextWidth(line + token) <= maxPx) {
        line += token
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      line = token.trimStart()
      while (line.length > 1 && getTextWidth(line.slice(0, 400)) > maxPx) { // a word wider than the screen
        const n = fit(line, maxPx)
        out.push(line.slice(0, n))
        line = line.slice(n)
      }
    }
    out.push(line.trimEnd())
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

/** Display lines grouped into parts that each fit one text box the glasses can scroll (never empty). */
export function toParts(text: string): string[] {
  const capped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (cut: longer than the glasses can show)` : text
  const parts: string[] = []
  let cur = ''
  for (const line of wrap(capped)) {
    if (cur && cur.length + 1 + line.length > PART_CHARS) {
      parts.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, PART_CHARS)
  }
  parts.push(cur)
  return parts.map(p => p || ' ')
}

/** `s` cut to `max` UTF-8 bytes, whole characters only (an emoji is never split). */
export function fitBytes(s: string, max: number): string {
  const enc = new TextEncoder()
  let out = ''
  for (const ch of s) {
    if (enc.encode(out + ch).length > max) break
    out += ch
  }
  return out
}
