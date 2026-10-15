// Runs one script inside a Web Worker, so a stuck script can be stopped (terminate) without freezing
// the page that handles the glasses (Even requires that a double-tap can always exit).
// Host calls (web requests, choices on the glasses) are forwarded to the page as messages.
// First: no network APIs and no code from text for scripts. Best effort: scripts are the user's own code, not a
// sandboxed adversary.
import './worker-lock.ts'
import { runScript } from './runtime/scriptable.ts'
import type { Host, RunOptions, RunResult } from './runtime/types.ts'

// All messages go over a private port the page sends with 'run'. A script can post on the worker's own channel
// (the interpreter can reach it), but the page doesn't listen there.
let port: MessagePort | null = null
const post = (m: unknown) => port?.postMessage(m)

const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()
let seq = 0

function ask<T>(op: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (v: never) => void, reject })
    post({ type: 'call', id, op, payload })
  })
}

const host: Host = {
  fetch: req => ask('fetch', req),
  present: choice => ask('present', choice),
  log: (level, text) => post({ type: 'log', level, text }),
  keychainChanged: (key, value) => post({ type: 'keychain', key, value }),
  fileChanged: (path, value) => post({ type: 'file', path, value }),
  show: output => post({ type: 'show', output }),
}

const unreadable: RunResult = { output: { kind: 'none', text: '' }, unsupported: [], usedNetwork: false,
  error: "The script finished, but its result couldn't be read (an unusual value in its output or error)." }

self.onmessage = async (e: MessageEvent) => {
  const m = e.data
  if (port || m?.type !== 'run' || !e.ports[0]) return // one run per worker, started by the page
  port = e.ports[0]
  port.onmessage = (r: MessageEvent) => {
    if (r.data?.type !== 'reply') return
    const p = pending.get(r.data.id)
    pending.delete(r.data.id)
    if (r.data.ok) p?.resolve(r.data.value as never)
    else p?.reject(new Error(r.data.error))
  }
  // A heartbeat the page can count on: it stops only while the script blocks this thread.
  setInterval(() => post({ type: 'alive' }), 5000)
  try { // always answer, or the page would wait on a run that has ended
    post({ type: 'done', result: await runScript(m.source as string, host, m.opts as RunOptions) })
  } catch {
    post({ type: 'done', result: unreadable })
  }
}
