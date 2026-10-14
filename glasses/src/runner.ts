// Starts a script in a Worker and answers its host calls: web requests go through the user's bridge,
// choices are shown on the glasses, Keychain/FileManager changes are saved after the run.
import RunnerWorker from './worker.ts?worker&inline'
import { runScript } from './runtime/scriptable.ts'
import type { Choice, Host, RelayRequest, RelayResponse, RunResult } from './runtime/types.ts'
import { store } from './store.ts'

const IDLE_LIMIT_MS = 30_000

export interface RunHooks {
  present(choice: Choice): Promise<number>
  log(level: string, text: string): void
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

const fail = (error: string): RunResult => ({ output: { kind: 'none', text: '' }, error, unsupported: [], usedNetwork: false })

export async function startRun(id: string, hooks: RunHooks, mode: 'app' | 'widget' = 'app'): Promise<RunHandle> {
  const meta = store.scripts.find(s => s.id === id)
  const source = await store.source(id)
  const modules: Record<string, string> = {}
  for (const s of store.scripts) if (s.id !== id) modules[s.name] = await store.source(s.id)
  const opts = {
    name: meta?.name ?? 'Script', runsInApp: mode === 'app', runsInWidget: mode === 'widget',
    keychain: store.keychain, files: store.files, modules,
  }
  let dirtyKeychain = false
  let dirtyFiles = false
  const save = async (r: RunResult) => {
    if (dirtyKeychain) await store.saveKeychain()
    if (dirtyFiles) await store.saveFiles()
    return r
  }
  const host: Host = {
    fetch: relay,
    present: hooks.present,
    log: hooks.log,
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
    // No Worker available: run on the page (a script that never yields can't be stopped then).
    hooks.log('warn', `Running without a Worker: ${e instanceof Error ? e.message : e}`)
    return { result: runScript(source, host, opts).then(save), abort: () => {} }
  }

  let finish: (r: RunResult) => void = () => {}
  const result = new Promise<RunResult>(resolve => { finish = resolve })
  let waiting = 0 // host calls in progress (a choice on the glasses can take as long as the user likes)
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = (r: RunResult) => {
    clearTimeout(timer)
    worker.terminate()
    finish(r)
  }
  const touch = () => {
    clearTimeout(timer)
    if (!waiting) timer = setTimeout(() => end(fail(`The script stopped responding for ${IDLE_LIMIT_MS / 1000} s and was stopped.`)), IDLE_LIMIT_MS)
  }

  worker.onerror = e => end(fail(e.message || 'The script could not start.'))
  worker.onmessage = async (e: MessageEvent) => {
    const m = e.data
    touch()
    if (m.type === 'done') end(await save(m.result as RunResult))
    else if (m.type === 'log') host.log(m.level, m.text)
    else if (m.type === 'keychain') host.keychainChanged(m.key, m.value)
    else if (m.type === 'file') host.fileChanged(m.path, m.value)
    else if (m.type === 'call') {
      waiting++
      touch()
      try {
        const value = m.op === 'fetch' ? await host.fetch(m.payload) : await host.present(m.payload)
        worker.postMessage({ type: 'reply', id: m.id, ok: true, value })
      } catch (err) {
        worker.postMessage({ type: 'reply', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      } finally {
        waiting--
        touch()
      }
    }
  }
  touch()
  worker.postMessage({ type: 'run', source, opts })
  return { result, abort: () => end(fail('Stopped.')) }
}
