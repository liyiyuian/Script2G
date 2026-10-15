// What a script must not reach, turned off for everything in this realm. Call both before the interpreter (sval)
// loads: it copies the global names it finds at that moment. src/worker-lock.ts does this for the app's worker.
// A script can also reach the real global object through the interpreter, so each name is changed wherever it
// lives on the global's prototype chain, not only shadowed.

/** Every object on the global's prototype chain that has its own `name` (e.g. WorkerGlobalScope.prototype). */
function owners(name: string): object[] {
  const out: object[] = []
  for (let o: object | null = globalThis; o; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, name)) out.push(o)
  return out
}

/** Scripts reach the web only through Request (the user's bridge), as the app's permissions say. Removes the
 * realm's own network APIs, including the ones that load a URL on the side (fonts, cache storage). */
export function blockNetwork(): void {
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource',
    'importScripts', 'Worker', 'SharedWorker', 'FontFace', 'fonts', 'caches']) {
    for (const o of owners(name)) {
      try { Object.defineProperty(o, name, { value: undefined, configurable: false, writable: false }) } catch { /* fixed by the engine */ }
    }
  }
}

/** Scripts run in an interpreter, so nothing needs the engine's ways of running code from text. Makes eval, new
 * Function (and its async/generator forms, also via `(() => {}).constructor`), string timers and WebAssembly
 * unavailable. `x instanceof Function` keeps working. */
export function blockCodeFromText(): void {
  const blocked = function () {
    throw new EvalError("Scripts can't run code from text (eval or the Function constructor).")
  }
  blocked.prototype = Function.prototype
  for (const f of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    Object.defineProperty(Object.getPrototypeOf(f), 'constructor', { value: blocked })
  }
  const g = globalThis as Record<string, unknown>
  for (const name of ['setTimeout', 'setInterval'] as const) {
    const timer = globalThis[name] as (fn: () => void, ms?: number, ...args: unknown[]) => unknown
    const safe = (fn: unknown, ...rest: unknown[]) => (typeof fn === 'function' ? timer(fn as () => void, ...rest as [number]) : blocked())
    for (const o of owners(name)) Object.defineProperty(o, name, { value: safe, writable: true, configurable: true })
    g[name] = safe // an own name too: the interpreter copies only the global's own names
  }
  g.eval = blocked
  g.Function = blocked
  g.WebAssembly = undefined
}
