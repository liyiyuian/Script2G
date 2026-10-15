// Runs after `npm install`: fixes two sval 0.6.12 bugs that silently give wrong results (tests/runtime.test.ts
// checks both). Each fix must match exactly once, so another sval version stops the install instead of shipping
// unfixed.
//  1. `return` inside a `try` that has a `finally` returned undefined (the finally block's result replaced it). The
//     fix also keeps the try's return value / break label, which sval stores in one shared object that any
//     function called inside the finally block overwrites.
//  2. `for await` over an array of promises gave the promises instead of their values.
import { readFileSync, writeFileSync } from 'node:fs'

const file = new URL('../node_modules/sval/dist/sval.js', import.meta.url)
const fixes = [
  ['e.finalizer && (i = yield* ce(e.finalizer, t));',
    'if (e.finalizer) { const res = k.RES, lab = i === _ || i === C ? i.LABEL : void 0; const f = yield* ce(e.finalizer, t); if (f === _ || f === C || f === k) i = f; else { k.RES = res; if (i === _ || i === C) i.LABEL = lab; } }'],
  ['e.finalizer && (i = fe(e.finalizer, t));',
    'if (e.finalizer) { const res = k.RES, lab = i === _ || i === C ? i.LABEL : void 0; const f = fe(e.finalizer, t); if (f === _ || f === C || f === k) i = f; else { k.RES = res; if (i === _ || i === C) i.LABEL = lab; } }'],
  [`  if (typeof Symbol == "function" && (t = e[Symbol.asyncIterator], !t && (t = e[Symbol.iterator])), t)
    return t.call(e);`,
  `  if (typeof Symbol == "function" && (t = e[Symbol.asyncIterator]))
    return t.call(e);
  if (typeof Symbol == "function" && (t = e[Symbol.iterator])) {
    const it = t.call(e);
    return { next: () => { const r = it.next(); return r.done ? r : Promise.resolve(r.value).then((value) => ({ value, done: false })); } };
  }`],
]

let s = readFileSync(file, 'utf8')
for (const [from, to] of fixes) {
  if (s.includes(to)) continue // already fixed
  if (s.split(from).length !== 2) throw new Error(`patch-sval: sval.js does not contain this code exactly once: ${from.slice(0, 60)}`)
  s = s.replace(from, to)
}
writeFileSync(file, s)
console.log('patch-sval: fixed try/finally and for-await in sval')
