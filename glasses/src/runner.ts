// Starts a script in a Worker and answers its host calls: web requests go through the user's bridge,
// choices are shown on the glasses, Keychain/FileManager changes are saved after the run.
import RunnerWorker from './worker.ts?worker&inline'
import type { Choice, Host, RelayRequest, RelayResponse, RunResult } from './runtime/types.ts'
import { store } from './store.ts'

// The worker sends a heartbeat every 5 s; three missed ones mean the script is blocking it (a loop).
const FROZEN_MS = 15_000

export interface RunHooks {
  present(choice: Choice): Promise<number>
  log(level: string, text: string): void
  show(output: RunResult['output']): void
}

export interface RunHandle {
  result: Promise<RunResult>
  abort(): void
}

async function bridgeCall(path: string, body?: unknown): Promise<Response> {
  const b = store.bridge
  if (!b?.url) throw new Error('This needs the bridge on your computer. Set it up on the phone page under Computer.')
  const res = await fetch(`${b.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) throw new Error('The bridge rejected the password. Check it on the phone page under Computer.')
  if (!res.ok) throw new Error(`The bridge answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res
}

/** Sends a script's web request through the bridge on the user's computer. */
export async function relay(req: RelayRequest): Promise<RelayResponse> {
  return (await (await bridgeCall('/api/fetch', req)).json()) as RelayResponse
}

/** Checks that the bridge answers and accepts the password. */
export async function ping(): Promise<void> {
  await bridgeCall('/api/ping')
}

/** The .js files in the scripts folder the bridge shares (names without .js). */
export async function bridgeScripts(): Promise<string[]> {
  const r = (await (await bridgeCall('/api/scripts')).json()) as { scripts: { name: string }[] }
  return r.scripts.map(s => s.name)
}

export async function bridgeScript(name: string): Promise<string> {
  return ((await (await bridgeCall(`/api/scripts/${encodeURIComponent(name)}`)).json()) as { source: string }).source
}

const fail = (error: string): RunResult => ({ output: { kind: 'none', text: '' }, error, unsupported: [], usedNetwork: false })

export async function startRun(id: string, hooks: RunHooks, mode: 'app' | 'widget' = 'app'): Promise<RunHandle> {
  const meta = store.scripts.find(s => s.id === id)
  const source = await store.source(id)
  const modules: Record<string, string> = {}
  // Other scripts are only needed by importModule. Reading them all would make a run wait on storage reads of
  // unrelated scripts (one at a time through the Even app) and fail if one of them can't be read.
  if (source.includes('importModule')) for (const s of store.scripts) if (s.id !== id) modules[s.name] = await store.source(s.id)
  const opts = {
    name: meta?.name ?? 'Script', runsInApp: mode === 'app', runsInWidget: mode === 'widget',
    keychain: store.keychain, files: store.files, modules, parameter: meta?.param,
  }
  let dirtyKeychain = false
  let dirtyFiles = false
  /** Saves what the script changed in Keychain / FileManager; a failed save becomes part of the run's error. */
  const save = async (r: RunResult): Promise<RunResult> => {
    try {
      if (dirtyKeychain) await store.saveKeychain()
      if (dirtyFiles) await store.saveFiles()
      return r
    } catch (e) {
      const why = `Couldn't save the script's Keychain or file changes: ${e instanceof Error ? e.message : e}`
      return { ...r, error: r.error ? `${r.error} ${why}` : why }
    }
  }
  const host: Host = {
    fetch: relay,
    present: hooks.present,
    log: hooks.log,
    show: hooks.show,
    keychainChanged: (k, v) => {
      if (v == null) delete store.keychain[k]
      else store.keychain[k] = v
      dirtyKeychain = true
    },
    fileChanged: (p, f) => {
      if (f == null) delete store.files[p]
      else store.files[p] = f
      dirtyFiles = true
    },
  }

  let worker: Worker
  try {
    worker = new RunnerWorker()
  } catch (e) {
    // Never run a script on this page instead: there it could read the bridge password and couldn't be stopped.
    return { result: Promise.resolve(fail(`Scripts can't run: the script runner (Web Worker) didn't start (${e instanceof Error ? e.message : e}).`)), abort: () => {} }
  }

  const channel = new MessageChannel() // private: the script can post on the worker's own channel, not on this one
  const port = channel.port1
  let finish: (r: RunResult) => void = () => {}
  const result = new Promise<RunResult>(resolve => { finish = resolve })
  let timer: ReturnType<typeof setTimeout> | undefined
  let ended = false
  const end = (r: RunResult) => { // every way a run ends (done, stopped, frozen, crashed) saves what it changed
    if (ended) return
    ended = true
    clearTimeout(timer)
    worker.terminate()
    port.close()
    void save(r).then(finish)
  }
  const touch = () => {
    clearTimeout(timer)
    if (ended) return
    timer = setTimeout(() => end(fail(`The script stopped responding for ${FROZEN_MS / 1000} s (a loop that never waits?) and was stopped.`)), FROZEN_MS)
  }

  worker.onerror = e => end(fail(e.message || 'The script could not start.'))
  port.onmessage = async (e: MessageEvent) => {
    const m = e.data
    touch()
    if (m.type === 'done') end(m.result as RunResult)
    else if (m.type === 'log') host.log(m.level, m.text)
    else if (m.type === 'keychain') host.keychainChanged(m.key, m.value)
    else if (m.type === 'file') host.fileChanged(m.path, m.value)
    else if (m.type === 'show') host.show(m.output)
    else if (m.type === 'call') {
      try {
        const value = m.op === 'fetch' ? await host.fetch(m.payload) : await host.present(m.payload)
        port.postMessage({ type: 'reply', id: m.id, ok: true, value })
      } catch (err) {
        port.postMessage({ type: 'reply', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  touch()
  worker.postMessage({ type: 'run', source, opts }, [channel.port2])
  return { result, abort: () => end(fail('Stopped.')) }
}
