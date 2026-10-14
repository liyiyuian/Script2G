// Scripts, settings, Keychain and FileManager data, kept in the Even app's storage (the SDK's
// setLocalStorage: Even's skills say browser localStorage doesn't reliably survive a restart here).
// Large values are split across keys of 50,000 characters, as Even's device-features skill shows.
import { call } from './sdk.ts'
import type { StoredFile } from './runtime/types.ts'
import { uuid } from './runtime/scriptable.ts'
import TIME_OF_DAY from './examples/time-of-day.js?raw'

export interface ScriptMeta {
  id: string
  name: string
  fav: boolean
  /** Scriptable's widget parameter (args.widgetParameter). */
  param?: string
}

export interface BridgeSettings {
  url: string
  token: string
}

const PREFIX = 'sr.'
const CHUNK = 50_000

const getRaw = (key: string) => call(b => b.getLocalStorage(PREFIX + key))
const setRaw = (key: string, value: string) => call(b => b.setLocalStorage(PREFIX + key, value))

export async function getBig(key: string): Promise<string> {
  const n = Number(await getRaw(`${key}.n`)) || 0
  let out = ''
  for (let i = 0; i < n; i++) out += await getRaw(`${key}.${i}`)
  return out
}

export async function setBig(key: string, text: string): Promise<void> {
  const old = Number(await getRaw(`${key}.n`)) || 0
  const n = Math.ceil(text.length / CHUNK)
  for (let i = 0; i < n; i++) await setRaw(`${key}.${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK))
  await setRaw(`${key}.n`, String(n))
  for (let i = n; i < old; i++) await setRaw(`${key}.${i}`, '')
}

async function getJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const s = await getBig(key)
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}

export const store = {
  scripts: [] as ScriptMeta[],
  startId: '' as string,
  keychain: {} as Record<string, string>,
  files: {} as Record<string, StoredFile>,
  bridge: null as BridgeSettings | null,
  sources: new Map<string, string>(),

  async load() {
    this.scripts = await getJSON('index', [])
    this.startId = await getRaw('start').catch(() => '') // a slow storage call must not leave the glasses blank
    this.keychain = await getJSON('keychain', {})
    this.files = await getJSON('files', {})
    this.bridge = await getJSON('bridge', null)
    try {
      if (!(await getRaw('seeded'))) { // first launch only: the one example that comes with the app
        await this.saveScript({ id: uuid(), name: 'Time of day', fav: false }, TIME_OF_DAY)
        await setRaw('seeded', '1')
      }
    } catch {
      // storage too slow right now: the example is added on a later launch
    }
  },

  async source(id: string): Promise<string> {
    if (!this.sources.has(id)) this.sources.set(id, await getBig(`script.${id}`))
    return this.sources.get(id) ?? ''
  },

  async saveScript(meta: ScriptMeta, source: string) {
    this.sources.set(meta.id, source)
    await setBig(`script.${meta.id}`, source)
    if (!this.scripts.some(s => s.id === meta.id)) this.scripts.push(meta)
    else this.scripts = this.scripts.map(s => (s.id === meta.id ? meta : s))
    await this.saveIndex()
  },

  async deleteScript(id: string) {
    this.scripts = this.scripts.filter(s => s.id !== id)
    this.sources.delete(id)
    await setBig(`script.${id}`, '')
    if (this.startId === id) await this.setStart('')
    await this.saveIndex()
  },

  /** Starred scripts first (they are also in the glasses menu), then the rest; alphabetical within each. */
  ordered(): ScriptMeta[] {
    return [...this.scripts].sort((a, b) => Number(b.fav) - Number(a.fav))
  },

  async saveIndex() {
    this.scripts.sort((a, b) => a.name.localeCompare(b.name))
    await setBig('index', JSON.stringify(this.scripts))
  },

  async setStart(id: string) {
    this.startId = id
    await setRaw('start', id)
  },

  saveKeychain() { return setBig('keychain', JSON.stringify(this.keychain)) },
  saveFiles() { return setBig('files', JSON.stringify(this.files)) },
  saveBridge() { return setBig('bridge', JSON.stringify(this.bridge)) },
}
