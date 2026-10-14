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
const setOk = async (key: string, value: string) => {
  if (!(await setRaw(key, value))) throw new Error("The Even app didn't save it")
}

// A value is stored as chunks plus a head "<count>@<a|b>" naming the chunk set. A new value is written to the
// other set and the head switched in one write, so a save that fails halfway leaves the old value intact.
// (A head without "@" is the older layout: chunks "<key>.<i>".)
const chunkKey = (key: string, gen: string | undefined, i: number) => (gen ? `${key}.${gen}.${i}` : `${key}.${i}`)

export async function getBig(key: string): Promise<string> {
  const [n, gen] = (await getRaw(`${key}.n`)).split('@')
  let out = ''
  for (let i = 0; i < (Number(n) || 0); i++) out += await getRaw(chunkKey(key, gen, i))
  return out
}

export async function setBig(key: string, text: string): Promise<void> {
  const [oldN, oldGen] = (await getRaw(`${key}.n`)).split('@')
  const gen = oldGen === 'a' ? 'b' : 'a'
  const n = Math.ceil(text.length / CHUNK)
  for (let i = 0; i < n; i++) await setOk(chunkKey(key, gen, i), text.slice(i * CHUNK, (i + 1) * CHUNK))
  await setOk(`${key}.n`, `${n}@${gen}`)
  for (let i = 0; i < (Number(oldN) || 0); i++) await setRaw(chunkKey(key, oldGen, i), '').catch(() => {}) // tidy up
}

/** Saved values that couldn't be read at launch: they are never overwritten, so a slow start can't erase them. */
const unreadable = new Set<string>()
const LABEL: Record<string, string> = { index: 'script list', keychain: 'Keychain', files: 'saved files', bridge: 'computer settings' }

async function getJSON<T>(key: string, fallback: T): Promise<T> {
  let s = ''
  try {
    s = await getBig(key).catch(() => getBig(key)) // one retry: the first call after launch can be slow
  } catch {
    unreadable.add(key)
    return fallback
  }
  try {
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    console.warn(`Saved ${LABEL[key] ?? key} was damaged and starts empty.`) // retrying can't repair it
    return fallback
  }
}

function guard(key: string) {
  if (unreadable.has(key)) {
    throw new Error(`Your saved ${LABEL[key] ?? key} couldn't be read when the app started, so it isn't overwritten. Close and reopen the app.`)
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
    guard('index') // before anything changes
    this.sources.set(meta.id, source)
    await setBig(`script.${meta.id}`, source)
    if (!this.scripts.some(s => s.id === meta.id)) this.scripts.push(meta)
    else this.scripts = this.scripts.map(s => (s.id === meta.id ? meta : s))
    await this.saveIndex()
  },

  async deleteScript(id: string) {
    guard('index')
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
    guard('index')
    this.scripts.sort((a, b) => a.name.localeCompare(b.name))
    await setBig('index', JSON.stringify(this.scripts))
  },

  /** What couldn't be read at launch ('' when everything loaded), for the phone page and the glasses. */
  problem(): string {
    if (!unreadable.size) return ''
    return `Your saved ${[...unreadable].map(k => LABEL[k] ?? k).join(', ')} couldn't be read when the app started. Nothing was changed or deleted. Close and reopen the app.`
  },

  async setStart(id: string) {
    this.startId = id
    await setRaw('start', id)
  },

  async saveKeychain() { guard('keychain'); await setBig('keychain', JSON.stringify(this.keychain)) },
  async saveFiles() { guard('files'); await setBig('files', JSON.stringify(this.files)) },
  async saveBridge() { guard('bridge'); await setBig('bridge', JSON.stringify(this.bridge)) },
}
