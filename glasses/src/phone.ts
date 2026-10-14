// The phone page inside the Even app, in three tabs: Scripts (add, run, organise), Computer (the optional
// bridge) and Keychain (values scripts read). No confirm()/alert(): the Even WebView may not show them.
import { store, type ScriptMeta } from './store.ts'
import { bridgeScript, bridgeScripts, ping } from './runner.ts'
import { uuid } from './runtime/scriptable.ts'
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
  <h1>EvenScriptable</h1>
  <p class="dim">Your JavaScript, on your G2 glasses.</p>
  <nav class="tabs">
    <button class="tab" data-tab="scripts">Scripts</button>
    <button class="tab" data-tab="computer">Computer</button>
    <button class="tab" data-tab="keychain">Keychain</button>
  </nav>
</header>

<section data-panel="scripts">
  <div class="row"><button id="new" class="accent grow">+ New script</button><button id="import" class="grow">Import from computer</button></div>
  <div id="import-panel" class="panel" hidden>
    <div class="row spread"><h2>Import from your computer</h2><button id="import-close">Close</button></div>
    <p class="dim">The .js files in the folder your bridge shares (~/Scripts unless you changed it).</p>
    <ul id="imports" class="list"></ul>
  </div>
  <input id="search" type="search" placeholder="Search scripts" hidden>
  <ul id="scripts" class="list"></ul>
  <p class="hint">On the glasses: <b>tap</b> runs · <b>swipe</b> moves or scrolls · <b>double-tap</b> goes back · <b>tap then hold</b> opens the menu.</p>
</section>

<section data-panel="computer" hidden>
  <div id="b-state" class="status"></div>
  <p class="dim">Only needed for scripts that load data from the web or from your computer. Your phone sends those requests to a small bridge on your own computer, over your own Tailscale network. Scripts that don't fetch anything work without it.</p>
  <ol class="steps">
    <li><b>Install the bridge on your computer.</b> One command; the steps are at github.com/liyiyuian/evenScriptable (Linux, Tailscale).</li>
    <li><b>Paste the address</b> the installer printed.<input id="b-url" placeholder="It starts with https and ends with :8447" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></li>
    <li><b>Paste the password</b> it printed.
      <div class="row nowrap"><input id="b-token" type="password" placeholder="Bridge password" autocapitalize="off" autocomplete="off" spellcheck="false"><button id="b-show">Show</button></div>
    </li>
  </ol>
  <div class="row"><button id="b-save" class="accent grow">Save and test</button><button id="b-remove" hidden>Remove</button></div>
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
</div>`

let editing: ScriptMeta | null = null
let openMore = '' // id of the script whose extra actions are shown
const results = new Map<string, { r: RunResult; at: Date }>() // last result per script name
const running = new Set<string>()

/** A button that needs a second tap within 3 s, for anything that deletes. */
function confirmButton(label: string, onConfirm: () => void | Promise<void>, cls = 'danger') {
  const b = el('button', { textContent: label, className: cls })
  let armed: ReturnType<typeof setTimeout> | undefined
  b.onclick = async () => {
    if (!armed) {
      b.textContent = 'Tap again to delete'
      armed = setTimeout(() => { b.textContent = label; armed = undefined }, 3000)
      return
    }
    clearTimeout(armed)
    await onConfirm()
  }
  return b
}

function showTab(name: string) {
  for (const t of document.querySelectorAll<HTMLButtonElement>('.tab')) t.classList.toggle('active', t.dataset.tab === name)
  for (const p of document.querySelectorAll<HTMLElement>('[data-panel]')) p.hidden = p.dataset.panel !== name
  if (name === 'computer') void checkBridge()
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
    const badges = el('span', { className: 'badges' })
    if (store.startId === s.id) badges.append(el('span', { className: 'badge', textContent: 'Opens at launch' }))
    if (s.fav) badges.append(el('span', { className: 'badge', textContent: '★ Starred' }))
    const run = el('button', {
      textContent: running.has(s.name) ? 'Running…' : 'Run', className: 'accent',
      onclick: () => {
        running.add(s.name)
        renderScripts()
        void runOnGlasses(s.id)
      },
    })
    const more = el('div', { className: 'more' })
    more.hidden = openMore !== s.id
    more.append(
      el('button', {
        textContent: s.fav ? '★ Unstar' : '☆ Star (top of the list + glasses menu)',
        onclick: async () => { s.fav = !s.fav; await store.saveIndex(); renderScripts(); await refresh() },
      }),
      el('button', {
        textContent: store.startId === s.id ? "Don't open at launch" : 'Open at launch',
        onclick: async () => { await store.setStart(store.startId === s.id ? '' : s.id); renderScripts() },
      }),
      confirmButton('Delete', async () => {
        await store.deleteScript(s.id)
        results.delete(s.name)
        renderScripts()
        await refresh()
      }),
    )
    const li = el('li', {},
      el('div', { className: 'card-head' }, el('span', { className: 'name', textContent: s.name }), badges),
      el('div', { className: 'actions' }, run,
        el('button', { textContent: 'Edit', onclick: () => void openEditor(s) }),
        el('button', { textContent: openMore === s.id ? 'Less' : 'More', onclick: () => { openMore = openMore === s.id ? '' : s.id; renderScripts() } })),
      more)
    const res = resultBlock(s.name)
    if (res) li.append(res)
    return li
  })
  const empty = store.scripts.length
    ? el('li', { className: 'dim', textContent: 'No script matches your search.' })
    : el('li', { className: 'dim', textContent: 'No scripts yet. Tap "+ New script" to paste one, or "Import from computer".' })
  $('#scripts').replaceChildren(...(rows.length ? rows : [empty]))
}

async function openEditor(s: ScriptMeta | null) {
  editing = s
  $('#ed-title').textContent = s ? 'Edit script' : 'New script'
  $<HTMLInputElement>('#ed-name').value = s?.name ?? ''
  $<HTMLInputElement>('#ed-param').value = s?.param ?? ''
  $<HTMLTextAreaElement>('#ed-code').value = s ? await store.source(s.id) : ''
  $('#ed-status').textContent = ''
  $('#editor').hidden = false
  document.body.classList.add('sheet-open')
}

function closeEditor() {
  $('#editor').hidden = true
  document.body.classList.remove('sheet-open')
}

async function saveEditor() {
  const say = (t: string) => { $('#ed-status').textContent = t }
  const name = $<HTMLInputElement>('#ed-name').value.trim()
  const code = $<HTMLTextAreaElement>('#ed-code').value
  if (!name) return say('Give the script a name.')
  if (!code.trim()) return say('Paste or type the script first.')
  if (store.scripts.some(s => s.name === name && s.id !== editing?.id)) return say(`There is already a script named "${name}".`)
  const param = $<HTMLInputElement>('#ed-param').value.trim() || undefined
  const meta = editing ? { ...editing, name, param } : { id: uuid(), name, fav: false, param }
  await store.saveScript(meta, code)
  closeEditor()
  renderScripts()
  await refresh()
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
          btn.textContent = 'Importing…'
          const old = store.scripts.find(s => s.name === name)
          await store.saveScript(old ?? { id: uuid(), name, fav: false }, await bridgeScript(name))
          btn.textContent = 'Imported ✓'
          renderScripts()
          await refresh()
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
  $('#b-remove').hidden = !store.bridge
}

async function checkBridge() {
  if (!store.bridge) return setBridgeState('unset', 'Not set up')
  setBridgeState('checking', 'Checking your computer…')
  try {
    await ping()
    setBridgeState('ok', '✓ Connected to your computer')
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
  $('#ed-save').onclick = () => void saveEditor()
  $('#ed-cancel').onclick = closeEditor

  $('#key-add').onclick = async () => {
    const k = $<HTMLInputElement>('#key').value.trim()
    const v = $<HTMLInputElement>('#val').value
    if (!k || !v) return void ($('#key-status').textContent = 'Fill in both the name and the value.')
    store.keychain[k] = v
    await store.saveKeychain()
    $<HTMLInputElement>('#key').value = $<HTMLInputElement>('#val').value = ''
    $('#key-status').textContent = `Saved "${k}".`
    renderKeys()
  }

  $<HTMLInputElement>('#b-url').value = store.bridge?.url ?? ''
  $<HTMLInputElement>('#b-token').value = store.bridge?.token ?? ''
  $('#b-show').onclick = () => {
    const t = $<HTMLInputElement>('#b-token')
    t.type = t.type === 'password' ? 'text' : 'password'
    $('#b-show').textContent = t.type === 'password' ? 'Show' : 'Hide'
  }
  $('#b-save').onclick = async () => {
    const url = $<HTMLInputElement>('#b-url').value.trim().replace(/\/+$/, '')
    const token = $<HTMLInputElement>('#b-token').value.trim()
    let ok = false
    try { ok = new URL(url).protocol === 'https:' } catch { /* not a URL */ }
    if (!ok) return void ($('#b-status').textContent = 'Paste the full address the installer printed (it starts with https and ends with :8447).')
    if (!token) return void ($('#b-status').textContent = 'Paste the password the installer printed.')
    store.bridge = { url, token }
    await store.saveBridge()
    $('#b-status').textContent = ''
    await checkBridge()
  }
  $('#b-remove').onclick = async () => {
    store.bridge = null
    await store.saveBridge()
    $<HTMLInputElement>('#b-url').value = $<HTMLInputElement>('#b-token').value = ''
    $('#b-status').textContent = 'Removed. Scripts that fetch data will say they need your computer.'
    setBridgeState('unset', 'Not set up')
  }

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
}
