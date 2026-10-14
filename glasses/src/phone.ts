// The phone page inside the Even app: manage scripts, Keychain values and the bridge, see the last run.
import { store, type ScriptMeta } from './store.ts'
import { ping } from './runner.ts'
import { events, refresh, runOnGlasses } from './glasses.ts'
import type { RunResult } from './runtime/types.ts'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...kids)
  return e
}

const PAGE = `
<header><h1>Script Runner</h1><p class="dim">Your JavaScript, on your glasses.</p></header>
<section>
  <div class="row"><input id="search" type="search" placeholder="Search scripts"><button id="new" class="accent">New script</button></div>
  <ul id="scripts" class="list"></ul>
</section>
<section id="editor" hidden>
  <h2 id="ed-title">New script</h2>
  <input id="ed-name" placeholder="Name" autocapitalize="off" autocomplete="off">
  <textarea id="ed-code" placeholder="Paste or type JavaScript" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
  <div class="row"><button id="ed-save" class="accent">Save</button><button id="ed-cancel">Cancel</button></div>
</section>
<section>
  <h2>Keychain</h2>
  <p class="dim">Values your scripts read with Keychain.get, such as API tokens. Stored on this phone.</p>
  <ul id="keys" class="list"></ul>
  <div class="row"><input id="key" placeholder="Key" autocapitalize="off"><input id="val" type="password" placeholder="Value"><button id="key-add">Add</button></div>
</section>
<section>
  <h2>Computer</h2>
  <p class="dim">Optional. Scripts that fetch from the web go through the bridge you install on your computer, on your own Tailscale network.</p>
  <input id="b-url" placeholder="Bridge address (from the installer)" autocapitalize="off" autocomplete="off">
  <input id="b-token" type="password" placeholder="Bridge password">
  <div class="row"><button id="b-save" class="accent">Save</button><button id="b-test">Test</button></div>
  <p id="b-status" class="dim"></p>
</section>
<section>
  <h2>Last run</h2>
  <pre id="log" class="dim">Nothing run yet.</pre>
</section>`

let editing: ScriptMeta | null = null

export function renderScripts() {
  const q = $<HTMLInputElement>('#search').value.trim().toLowerCase()
  const rows = store.scripts.filter(s => s.name.toLowerCase().includes(q)).map(s => {
    const act = (label: string, fn: () => void, cls = '') => el('button', { textContent: label, className: cls, onclick: fn })
    return el('li', {},
      el('span', { className: 'name', textContent: (store.startId === s.id ? '» ' : '') + s.name }),
      el('span', { className: 'actions' },
        act('Run', () => void runOnGlasses(s.id), 'accent'),
        act(s.fav ? '★' : '☆', async () => { s.fav = !s.fav; await store.saveIndex(); renderScripts(); await refresh() }),
        act(store.startId === s.id ? 'Start ✓' : 'Start', async () => { await store.setStart(store.startId === s.id ? '' : s.id); renderScripts() }),
        act('Edit', () => void openEditor(s)),
        act('Delete', async () => { if (confirm(`Delete "${s.name}"?`)) { await store.deleteScript(s.id); renderScripts(); await refresh() } }),
      ))
  })
  $('#scripts').replaceChildren(...(rows.length ? rows : [el('li', { className: 'dim', textContent: store.scripts.length ? 'No match.' : 'No scripts yet. Tap New script.' })]))
}

async function openEditor(s: ScriptMeta | null) {
  editing = s
  $('#ed-title').textContent = s ? `Edit ${s.name}` : 'New script'
  $<HTMLInputElement>('#ed-name').value = s?.name ?? ''
  $<HTMLTextAreaElement>('#ed-code').value = s ? await store.source(s.id) : ''
  $('#editor').hidden = false
  $('#editor').scrollIntoView({ behavior: 'smooth' })
}

async function saveEditor() {
  const name = $<HTMLInputElement>('#ed-name').value.trim()
  if (!name) return alert('Give the script a name.')
  if (store.scripts.some(s => s.name === name && s.id !== editing?.id)) return alert(`There is already a script named "${name}".`)
  const meta = editing ? { ...editing, name } : { id: crypto.randomUUID(), name, fav: false }
  await store.saveScript(meta, $<HTMLTextAreaElement>('#ed-code').value)
  $('#editor').hidden = true
  renderScripts()
  await refresh()
}

function renderKeys() {
  const rows = Object.keys(store.keychain).sort().map(k => el('li', {},
    el('span', { className: 'name', textContent: k }),
    el('span', { className: 'actions' }, el('button', {
      textContent: 'Delete',
      onclick: async () => { delete store.keychain[k]; await store.saveKeychain(); renderKeys() },
    }))))
  $('#keys').replaceChildren(...(rows.length ? rows : [el('li', { className: 'dim', textContent: 'No values.' })]))
}

function showResult(name: string, r: RunResult) {
  const lines = [`${name} — ${new Date().toLocaleTimeString()}`]
  if (r.error) lines.push(`Error: ${r.error}`)
  if (r.unsupported.length) lines.push(`Not available on the glasses: ${r.unsupported.join(', ')}`)
  if (r.usedNetwork) lines.push('Used the bridge for web requests.')
  if (r.output.text) lines.push('', r.output.text.slice(0, 4000))
  $('#log').textContent = lines.join('\n')
}

export function mountPhone(root: HTMLElement) {
  root.innerHTML = PAGE
  $('#search').oninput = renderScripts
  $('#new').onclick = () => void openEditor(null)
  $('#ed-save').onclick = () => void saveEditor()
  $('#ed-cancel').onclick = () => { $('#editor').hidden = true }
  $('#key-add').onclick = async () => {
    const k = $<HTMLInputElement>('#key').value.trim()
    if (!k) return
    store.keychain[k] = $<HTMLInputElement>('#val').value
    await store.saveKeychain()
    $<HTMLInputElement>('#key').value = $<HTMLInputElement>('#val').value = ''
    renderKeys()
  }
  $<HTMLInputElement>('#b-url').value = store.bridge?.url ?? ''
  $<HTMLInputElement>('#b-token').value = store.bridge?.token ?? ''
  $('#b-save').onclick = async () => {
    const url = $<HTMLInputElement>('#b-url').value.trim().replace(/\/+$/, '')
    let ok = false
    try { ok = !url || new URL(url).protocol === 'https:' } catch { /* not a URL */ }
    if (!ok) return void ($('#b-status').textContent = 'Paste the full address the installer printed (it starts with https and ends with :8447).')
    store.bridge = url ? { url, token: $<HTMLInputElement>('#b-token').value.trim() } : null
    await store.saveBridge()
    $('#b-status').textContent = url ? 'Saved.' : 'Bridge removed.'
  }
  $('#b-test').onclick = async () => {
    $('#b-status').textContent = 'Testing…'
    try {
      await ping()
      $('#b-status').textContent = 'Connected: the bridge accepted the password.'
    } catch (e) {
      $('#b-status').textContent = e instanceof Error ? e.message : String(e)
    }
  }
  events.onResult = showResult
  events.onLog = (level, text) => { if (level !== 'log') console.warn(`[script ${level}]`, text) }
  renderScripts()
  renderKeys()
}
