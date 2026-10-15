// What a script must not reach, turned off for everything in this realm. Call both before the interpreter (sval)
// loads: it copies the global names it finds at that moment. src/worker-lock.ts does this for the app's worker.

/** Scripts reach the web only through Request (the user's bridge), as the app's permissions say. Removes the
 * realm's own network APIs, wherever they live on the prototype chain. */
export function blockNetwork(): void {
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker']) {
    for (let o: object | null = globalThis; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        try { Object.defineProperty(o, name, { value: undefined, configurable: false, writable: false }) } catch { /* fixed by the engine */ }
      }
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
    g[name] = (fn: unknown, ...rest: unknown[]) => (typeof fn === 'function' ? timer(fn as () => void, ...rest as [number]) : blocked())
  }
  g.eval = blocked
  g.Function = blocked
  g.WebAssembly = undefined
}
