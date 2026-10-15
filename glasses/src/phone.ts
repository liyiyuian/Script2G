// The phone page inside the Even app, in three tabs: Scripts (add, run, organise), Computer (the optional
// bridge) and Keychain (values scripts read). No confirm()/alert(): the Even WebView may not show them.
import { store, type ScriptMeta } from './store.ts'
import { bridgeScript, bridgeScripts, ping } from './runner.ts'
import { uuid } from './runtime/uuid.ts'
import { events, refresh, runOnGlasses } from './glasses.ts'
import type { RunResult } from './runtime/types.ts'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...kids)
  return e
}

const PAGE = `
<header class="top">
  <h1>Script2G</h1>
  <p class="dim">Your JavaScript, on your G2 glasses.</p>
  <p id="notice" class="notice" hidden></p>
  <nav class="tabs">
    <button class="tab" data-tab="scripts">Scripts</button>
    <button class="tab" data-tab="computer">Computer</button>
    <button class="tab" data-tab="keychain">Keychain</button>
  </nav>
</header>

<section data-panel="scripts">
  <div class="row nowrap"><button id="new" class="accent grow">+ New script</button><button id="import" class="grow">Import</button></div>
  <p class="hint">On the glasses: <b>tap</b> runs · <b>swipe</b> moves or scrolls · <b>double-tap</b> goes back · <b>tap then hold</b> opens the menu with your ★ scripts.</p>
  <div id="import-panel" class="panel" hidden>
    <div class="row spread"><h2>Import from your computer</h2><button id="import-close">Close</button></div>
    <p class="dim">The .js files in the folder your bridge shares (~/Scripts unless you changed it).</p>
    <ul id="imports" class="list"></ul>
  </div>
  <input id="search" type="search" placeholder="Search scripts" hidden>
  <ul id="scripts" class="list"></ul>
</section>

<section data-panel="computer" hidden>
  <div id="b-state" class="status"></div>
  <div id="b-summary" class="row" hidden><button id="b-test">Test again</button><button id="b-change">Change</button><span id="b-remove-slot"></span></div>
  <div id="b-setup">
    <p class="dim">Only needed for scripts that load data from the web or from your computer. Your phone sends those requests to a small bridge on your own computer, over your own Tailscale network. Scripts that don't fetch anything work without it.</p>
    <ol class="steps">
      <li><b>Install the bridge on your computer.</b> One command; the steps are at github.com/liyiyuian/Script2G (Linux, Tailscale).</li>
      <li><b>Paste the address</b> the installer printed.<input id="b-url" placeholder="It starts with https and ends with :8447" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></li>
      <li><b>Paste the password</b> it printed.
        <div class="row nowrap"><input id="b-token" type="password" placeholder="Bridge password" autocapitalize="off" autocomplete="off" spellcheck="false"><button id="b-show">Show</button></div>
      </li>
    </ol>
    <div class="row"><button id="b-save" class="accent grow">Save and test</button><button id="b-cancel" hidden>Cancel</button></div>
  </div>
  <p id="b-status" class="note"></p>
</section>

<section data-panel="keychain" hidden>
  <p class="dim">Values your scripts read with <code>Keychain.get("name")</code>, such as API tokens. You can't type on the glasses, so add them here once. They are stored on this phone, and every script you add can read them.</p>
  <ul id="keys" class="list"></ul>
  <h2>Add a value</h2>
  <input id="key" placeholder="Name, e.g. weather_api_key" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
  <div class="row nowrap"><input id="val" type="password" placeholder="Value" autocapitalize="off" autocomplete="off" spellcheck="false"><button id="key-add" class="accent">Add</button></div>
  <p id="key-status" class="note"></p>
</section>

<div id="editor" class="sheet" hidden>
  <div class="sheet-bar"><button id="ed-cancel">Cancel</button><h2 id="ed-title">New script</h2><button id="ed-save" class="accent">Save</button></div>
  <label>Name<input id="ed-name" placeholder="What the glasses list shows" autocapitalize="off" autocomplete="off"></label>
  <label>Parameter <span class="dim">(optional)</span><input id="ed-param" placeholder="Like a widget parameter in Scriptable" autocapitalize="off" autocomplete="off"></label>
  <p class="dim small">Scripts read it as <code>args.widgetParameter</code>.</p>
  <label class="grow-label">Code<textarea id="ed-code" placeholder="Paste or type JavaScript" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea></label>
  <p id="ed-status" class="note"></p>
  <button id="ed-run" class="accent">Save and run on glasses</button>
  <label class="check"><input id="ed-start" type="checkbox"> Open this script when the app starts</label>
  <div id="ed-delete-slot"></div>
</div>`

let editing: ScriptMeta | null = null
let changingBridge = false // the Computer tab shows the setup form while connected
const results = new Map<string, { r: RunResult; at: Date }>() // last result per script name
const running = new Set<string>()

/** A button that needs a second tap within 3 s, for anything that deletes. */
function confirmButton(label: string, onConfirm: () => void | Promise<void>, armedLabel = 'Tap again to delete') {
  const b = el('button', { textContent: label, className: 'danger' })
  let armed: ReturnType<typeof setTimeout> | undefined
  b.onclick = async () => {
    if (!armed) {
      b.textContent = armedLabel
      armed = setTimeout(() => { b.textContent = label; armed = undefined }, 3000)
      return
    }
    clearTimeout(armed)
    await safe(onConfirm)()
  }
  return b
}

/** Shows a failure from any button (e.g. storage that couldn't be read) instead of losing it. */
function report(e: unknown) {
  const n = $('#notice')
  n.textContent = e instanceof Error ? e.message : String(e)
  n.hidden = false
}

/** An async click handler whose errors are shown in the notice line. */
const safe = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
  try {
    await fn(...a)
  } catch (e) {
    report(e)
  }
}

function showTab(name: string) {
  for (const t of document.querySelectorAll<HTMLButtonElement>('.tab')) t.classList.toggle('active', t.dataset.tab === name)
  for (const p of document.querySelectorAll<HTMLElement>('[data-panel]')) p.hidden = p.dataset.panel !== name
  if (name === 'computer') {
    changingBridge = false
    renderComputer()
    void checkBridge()
  }
  if (name === 'keychain') renderKeys()
}

function resultBlock(name: string) {
  const res = results.get(name)
  if (running.has(name)) return el('div', { className: 'result', textContent: 'Running on your glasses…' })
  if (!res) return null
  const { r, at } = res
  const lines: string[] = []
  if (r.error) lines.push(`Error: ${r.error}`)
  if (r.unsupported.length) lines.push(`Not available on the glasses: ${r.unsupported.join(', ')}`)
  if (r.output.text) lines.push(r.output.text.slice(0, 1500))
  return el('div', { className: r.error ? 'result error' : 'result' },
    el('div', { className: 'small dim', textContent: `Last run ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${r.usedNetwork ? ' · used your computer' : ''}` }),
    el('pre', { textContent: lines.join('\n') || 'Done (no output).' }))
}

export function renderScripts() {
  const search = $<HTMLInputElement>('#search')
  search.hidden = store.scripts.length < 6
  const q = search.value.trim().toLowerCase()
  const rows = store.ordered().filter(s => s.name.toLowerCase().includes(q)).map(s => {
    const star = el('button', {
      className: s.fav ? 'icon on' : 'icon', textContent: s.fav ? '★' : '☆', ariaLabel: s.fav ? 'Unstar' : 'Star',
      onclick: safe(async () => { s.fav = !s.fav; await store.saveIndex(); renderScripts(); await refresh() }),
    })
    const name = el('div', { className: 'card-name' }, el('span', { className: 'name', textContent: s.name }))
    if (store.startId === s.id) name.append(el('span', { className: 'badge', textContent: 'Opens at launch' }))
    const li = el('li', { className: 'card' },
      el('div', { className: 'card-row' }, star, name,
        el('button', { textContent: 'Edit', onclick: () => void openEditor(s) }),
        el('button', { textContent: running.has(s.name) ? 'Running…' : 'Run', className: 'accent', onclick: () => runFromPhone(s) })))
    const res = resultBlock(s.name)
    if (res) li.append(res)
    return li
  })
  const empty = store.scripts.length
    ? el('li', { className: 'dim', textContent: 'No script matches your search.' })
    : el('li', { className: 'dim', textContent: 'No scripts yet. Tap "+ New script" to paste one, or "Import from computer".' })
  $('#scripts').replaceChildren(...(rows.length ? rows : [empty]))
}

function runFromPhone(s: ScriptMeta) {
  running.add(s.name)
  renderScripts()
  void runOnGlasses(s.id).catch(report).finally(() => { running.delete(s.name); renderScripts() })
}

async function openEditor(s: ScriptMeta | null) {
  editing = s
  $('#ed-title').textContent = s ? 'Edit script' : 'New script'
  $<HTMLInputElement>('#ed-name').value = s?.name ?? ''
  $<HTMLInputElement>('#ed-param').value = s?.param ?? ''
  $<HTMLTextAreaElement>('#ed-code').value = s ? await store.source(s.id) : ''
  $<HTMLInputElement>('#ed-start').checked = !!s && store.startId === s.id
  $('#ed-delete-slot').replaceChildren(...(s ? [confirmButton('Delete script', async () => {
    await store.deleteScript(s.id)
    results.delete(s.name)
    closeEditor()
    renderScripts()
    await refresh()
  })] : []))
  $('#ed-status').textContent = ''
  $('#editor').hidden = false
  document.body.classList.add('sheet-open')
}

function closeEditor() {
  $('#editor').hidden = true
  document.body.classList.remove('sheet-open')
}

async function saveEditor(run: boolean) {
  const btns = [$<HTMLButtonElement>('#ed-save'), $<HTMLButtonElement>('#ed-run')]
  if (btns.some(b => b.disabled)) return
  for (const b of btns) b.disabled = true // a double tap must not save twice
  try {
    const saved = await saveEditorOnce()
    if (saved && run) runFromPhone(saved)
  } catch (e) {
    $('#ed-status').textContent = e instanceof Error ? e.message : String(e)
  } finally {
    for (const b of btns) b.disabled = false
  }
}

/** Saves the editor's script; returns it, or null (with the reason shown) if it can't be saved yet. */
async function saveEditorOnce(): Promise<ScriptMeta | null> {
  const say = (t: string) => { $('#ed-status').textContent = t; return null }
  const name = $<HTMLInputElement>('#ed-name').value.trim()
  const code = $<HTMLTextAreaElement>('#ed-code').value
  if (!name) return say('Give the script a name.')
  if (!code.trim()) return say('Paste or type the script first.')
  if (store.scripts.some(s => s.name === name && s.id !== editing?.id)) return say(`There is already a script named "${name}".`)
  const param = $<HTMLInputElement>('#ed-param').value.trim() || undefined
  const meta = editing ? { ...editing, name, param } : { id: uuid(), name, fav: false, param }
  await store.saveScript(meta, code)
  const start = $<HTMLInputElement>('#ed-start').checked
  if (start !== (store.startId === meta.id)) await store.setStart(start ? meta.id : '')
  closeEditor()
  renderScripts()
  await refresh()
  return store.scripts.find(s => s.id === meta.id) ?? meta
}

async function showImports() {
  const box = $('#imports')
  $('#import-panel').hidden = false
  $('#import-panel').scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (!store.bridge) {
    box.replaceChildren(el('li', {},
      el('span', { className: 'dim', textContent: 'Set up your computer first (Computer tab).' }),
      el('div', { className: 'actions' }, el('button', { textContent: 'Open Computer', className: 'accent', onclick: () => showTab('computer') }))))
    return
  }
  box.replaceChildren(el('li', { className: 'dim', textContent: 'Asking your computer…' }))
  try {
    const names = await bridgeScripts()
    const rows = names.map(name => el('li', {},
      el('span', { className: 'name', textContent: name }),
      el('span', { className: 'actions' }, el('button', {
        textContent: store.scripts.some(s => s.name === name) ? 'Import again (replace)' : 'Import',
        className: 'accent',
        onclick: async (e: MouseEvent) => {
          const btn = e.currentTarget as HTMLButtonElement
          if (btn.disabled) return
          btn.disabled = true // a double tap must not import twice
          btn.textContent = 'Importing…'
          try {
            const old = store.scripts.find(s => s.name === name)
            await store.saveScript(old ?? { id: uuid(), name, fav: false }, await bridgeScript(name))
            btn.textContent = 'Imported ✓'
            renderScripts()
            await refresh()
          } catch (err) {
            btn.textContent = 'Import'
            btn.disabled = false
            report(err)
          }
        },
      }))))
    box.replaceChildren(...(rows.length ? rows : [el('li', { className: 'dim', textContent: 'The scripts folder on your computer has no .js files (or none is set).' })]))
  } catch (e) {
    box.replaceChildren(el('li', { className: 'dim', textContent: e instanceof Error ? e.message : String(e) }))
  }
}

function setBridgeState(kind: 'unset' | 'checking' | 'ok' | 'error', text: string) {
  const s = $('#b-state')
  s.className = `status ${kind}`
  s.textContent = text
}

/** Set up: a short summary (Test again, Change, Remove). Not set up, or changing: the setup steps and form. */
function renderComputer() {
  const b = store.bridge
  $<HTMLInputElement>('#b-url').value = b?.url ?? ''
  $<HTMLInputElement>('#b-token').value = b?.token ?? ''
  $('#b-summary').hidden = !b || changingBridge
  $('#b-setup').hidden = !!b && !changingBridge
  $('#b-cancel').hidden = !b
  $('#b-remove-slot').replaceChildren(confirmButton('Remove', async () => {
    store.bridge = null
    await store.saveBridge()
    changingBridge = false
    renderComputer()
    $('#b-status').textContent = 'Removed. Scripts that fetch data will say they need your computer.'
    setBridgeState('unset', 'Not set up')
  }, 'Tap again to remove'))
}

async function checkBridge() {
  if (!store.bridge) return setBridgeState('unset', 'Not set up')
  setBridgeState('checking', 'Checking your computer…')
  try {
    await ping()
    let host = ''
    try { host = new URL(store.bridge.url).hostname } catch { /* shown without a name */ }
    if (!/^[\d.]+$|:/.test(host)) host = host.split('.')[0] // the computer's name, not its whole tailnet address
    setBridgeState('ok', `✓ Connected to your computer${host ? ` (${host})` : ''}`)
    $('#b-status').textContent = ''
  } catch (e) {
    setBridgeState('error', "Can't reach your computer")
    $('#b-status').textContent = e instanceof Error ? e.message : String(e)
  }
}

function renderKeys() {
  const masked = (k: string) => `${'•'.repeat(8)} (${store.keychain[k].length} characters)`
  const rows = Object.keys(store.keychain).sort().map(k => {
    const value = el('span', { className: 'small dim mono', textContent: masked(k) })
    let shown = false
    return el('li', {},
      el('div', { className: 'card-head' }, el('span', { className: 'name mono', textContent: k })),
      value,
      el('div', { className: 'actions' },
        el('button', {
          textContent: 'Show',
          onclick: (e: MouseEvent) => {
            shown = !shown
            value.textContent = shown ? store.keychain[k] : masked(k)
            ;(e.currentTarget as HTMLButtonElement).textContent = shown ? 'Hide' : 'Show'
          },
        }),
        confirmButton('Delete', async () => { delete store.keychain[k]; await store.saveKeychain(); renderKeys() })))
  })
  $('#keys').replaceChildren(...(rows.length ? rows : [el('li', { className: 'dim', textContent: 'No values yet.' })]))
}

export function mountPhone(root: HTMLElement) {
  root.innerHTML = PAGE
  for (const t of document.querySelectorAll<HTMLButtonElement>('.tab')) t.onclick = () => showTab(t.dataset.tab ?? 'scripts')
  $('#search').oninput = renderScripts
  $('#new').onclick = () => void openEditor(null)
  $('#import').onclick = () => void showImports()
  $('#import-close').onclick = () => { $('#import-panel').hidden = true }
  $('#ed-save').onclick = () => void saveEditor(false)
  $('#ed-run').onclick = () => void saveEditor(true)
  $('#ed-cancel').onclick = closeEditor

  $('#key-add').onclick = safe(async () => {
    const k = $<HTMLInputElement>('#key').value.trim()
    const v = $<HTMLInputElement>('#val').value
    if (!k || !v) return void ($('#key-status').textContent = 'Fill in both the name and the value.')
    if (k === '__proto__') return void ($('#key-status').textContent = 'That name can\'t be used. Pick another.')
    store.keychain[k] = v
    await store.saveKeychain()
    $<HTMLInputElement>('#key').value = $<HTMLInputElement>('#val').value = ''
    $('#key-status').textContent = `Saved "${k}".`
    renderKeys()
  })

  $('#b-show').onclick = () => {
    const t = $<HTMLInputElement>('#b-token')
    t.type = t.type === 'password' ? 'text' : 'password'
    $('#b-show').textContent = t.type === 'password' ? 'Show' : 'Hide'
  }
  $('#b-save').onclick = safe(async () => {
    const url = $<HTMLInputElement>('#b-url').value.trim().replace(/\/+$/, '')
    const token = $<HTMLInputElement>('#b-token').value.trim()
    let ok = false
    try { ok = new URL(url).protocol === 'https:' } catch { /* not a URL */ }
    if (!ok) return void ($('#b-status').textContent = 'Paste the full address the installer printed (it starts with https and ends with :8447).')
    if (!token) return void ($('#b-status').textContent = 'Paste the password the installer printed.')
    store.bridge = { url, token }
    await store.saveBridge()
    changingBridge = false
    renderComputer()
    $('#b-status').textContent = ''
    await checkBridge()
  })
  $('#b-test').onclick = () => void checkBridge()
  $('#b-change').onclick = () => { changingBridge = true; renderComputer() }
  $('#b-cancel').onclick = () => { changingBridge = false; renderComputer() }

  events.onResult = (name, r) => {
    running.delete(name)
    results.set(name, { r, at: new Date() })
    renderScripts()
    renderKeys() // a script may have saved a Keychain value
  }
  events.onLog = (level, text) => { if (level !== 'log') console.warn(`[script ${level}]`, text) }
  setBridgeState(store.bridge ? 'checking' : 'unset', store.bridge ? 'Saved (open this tab to check it)' : 'Not set up')
  showTab('scripts')
  renderScripts()
  renderKeys()
  if (store.problem()) report(store.problem())
}
