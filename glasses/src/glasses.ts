// What the glasses show, and what each gesture does there.
//   Script list (root):  swipe = move (firmware), tap = run, double-tap = Even's exit dialog
//   Output:              swipe = scroll (the glasses scroll the text themselves), tap = run again,
//                        double-tap = back to the list (and stop it if still running)
//   Choice (Alert/UITable): tap = pick, double-tap = cancel
//   System menu (tap then hold): "All scripts", "Next part"/"Previous part" for long output, favourite scripts
import {
  CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty, MenuContainerProperty, MenuItemProperty,
  OsEventTypeList, RebuildPageContainer, TextContainerProperty, TextContainerUpgrade, type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth, pxTruncate } from '@evenrealities/pretext'
import { bridge, call } from './sdk.ts'
import { store } from './store.ts'
import { startRun, type RunHandle } from './runner.ts'
import type { Choice, RunResult } from './runtime/types.ts'

const W = 576
const H = 288
const PAD = 4
const INNER = W - 2 * PAD
const LINE_PX = 27 // fixed line height of the firmware font (Even's pretext docs)
const ITEM_PX = 40 // fixed list item height (same docs); a list shorter than its box is drawn centred in it
const HEAD_H = LINE_PX + 2 * PAD // the fixed title line above a script's output
// A text box the glasses scroll themselves holds about 1000 characters (rebuild limit; the simulator refused
// a 1390-character update), so longer output is split into parts of up to PART_CHARS.
const PART_CHARS = 950
const LIST_MAX = 20 // firmware limit on list items
const PER_PAGE = 18 // when a list is longer, 18 items + "Previous page"/"Next page"
const MENU_ALL = 1
const MENU_NEXT = 2
const MENU_PREV = 3
const MENU_FAV = 100

/** Splits text into display lines at word boundaries, measured with the firmware font. */
export function wrap(text: string, maxPx = INNER): string[] {
  const out: string[] = []
  for (const para of text.replace(/\t/g, '  ').split('\n')) {
    let line = ''
    for (const token of para.split(/(\s+)/).filter(Boolean)) {
      if (getTextWidth(line + token) <= maxPx) {
        line += token
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      line = token.trimStart()
      while (getTextWidth(line) > maxPx) { // a single word wider than the screen
        let n = line.length - 1
        while (n > 1 && getTextWidth(line.slice(0, n)) > maxPx) n--
        out.push(line.slice(0, n))
        line = line.slice(n)
      }
    }
    out.push(line.trimEnd())
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

function fitBytes(s: string, max: number): string {
  while (new TextEncoder().encode(s).length > max) s = s.slice(0, -1)
  return s
}

type View =
  | { kind: 'list'; page: number }
  | { kind: 'message'; text: string }
  | { kind: 'busy'; title: string; since: number; note?: string }
  | { kind: 'output'; title: string; parts: string[]; part: number; scriptId: string; running?: boolean; note?: string }
  | { kind: 'choice'; choice: Choice; page: number; resolve: (i: number) => void }

let view: View = { kind: 'message', text: '' }
let layout: 'text' | 'list' | 'output' | null = null
let shownBody = '' // the output body on the glasses, so a header-only change keeps the scroll position
let started = false
let createTimedOut = false // the start-page call got no answer, but it may still have reached the glasses
let retry: ReturnType<typeof setTimeout> | undefined
let run: RunHandle | null = null
let runSeq = 0 // which run the glasses belong to; a stopped or replaced run is ignored
let menuFavIds: string[] = []
let liveTimer: ReturnType<typeof setTimeout> | undefined
let liveLast = 0

/** The phone page listens here for each finished run. */
export const events = { onResult: (_name: string, _r: RunResult) => {}, onLog: (_level: string, _text: string) => {} }

function menu(): MenuContainerProperty {
  const parts = view.kind === 'output' && view.parts.length > 1
  const favs = store.scripts.filter(s => s.fav).slice(0, parts ? 7 : 9) // the firmware allows 10 items
  menuFavIds = favs.map(s => s.id)
  return new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemID: MENU_ALL, itemName: 'All scripts' }),
      ...(parts ? [new MenuItemProperty({ itemID: MENU_NEXT, itemName: 'Next part' }), new MenuItemProperty({ itemID: MENU_PREV, itemName: 'Previous part' })] : []),
      ...favs.map((s, i) => new MenuItemProperty({ itemID: MENU_FAV + i, itemName: fitBytes(s.name, 32) })),
    ],
  })
}

/** Display lines grouped into parts that each fit one text box the glasses can scroll. */
function toParts(text: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (const line of wrap(text || ' ')) {
    if (cur && cur.length + 1 + line.length > PART_CHARS) {
      parts.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, PART_CHARS)
  }
  parts.push(cur)
  return parts
}

async function page(textObject: TextContainerProperty[], list?: ListContainerProperty) {
  const c = {
    containerTotalNum: textObject.length + (list ? 1 : 0),
    textObject, listObject: list ? [list] : undefined, menuObject: menu(),
  }
  if (!started) {
    const r = await call(b => b.createStartUpPageContainer(new CreateStartUpPageContainer(c))) // throws on no answer
    started = true // created exactly once; every later page is a rebuild
    if (r === 0) return
    if (!createTimedOut) return console.error('createStartUpPageContainer failed with code', r)
    // An earlier start-page call timed out but reached the glasses after all: draw this page as a rebuild.
  }
  await call(b => b.rebuildPageContainer(new RebuildPageContainer(c)))
}

async function showText(content: string) {
  if (layout === 'text') {
    await call(b => b.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', contentOffset: 0, contentLength: 0, content })))
    return
  }
  await page([new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: W, height: H, borderWidth: 0, borderColor: 0, paddingLength: PAD,
    containerID: 1, containerName: 'main', content, isEventCapture: 1,
  })])
  layout = 'text'
}

const upgrade = (containerID: number, containerName: string, content: string) =>
  call(b => b.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, contentOffset: 0, contentLength: 0, content })))

/** A fixed header line, and the output below it in a text box the glasses scroll themselves (no redraw per swipe). */
async function showOutput(header: string, body: string) {
  if (layout === 'output') {
    await upgrade(2, 'head', header)
    if (body !== shownBody) await upgrade(1, 'main', body) // new text starts at the top again
    shownBody = body
    return
  }
  await page([
    new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: W, height: HEAD_H, borderWidth: 0, borderColor: 0, paddingLength: PAD,
      containerID: 2, containerName: 'head', content: header, isEventCapture: 0,
    }),
    new TextContainerProperty({
      xPosition: 0, yPosition: HEAD_H, width: W, height: H - HEAD_H, borderWidth: 0, borderColor: 0, paddingLength: PAD,
      containerID: 1, containerName: 'main', content: body, isEventCapture: 1,
    }),
  ])
  layout = 'output'
  shownBody = body
}

async function showList(title: string, labels: string[]) {
  const head = title ? wrap(title).slice(0, 2) : []
  const headH = head.length ? head.length * LINE_PX + 2 * PAD : 0
  const texts = head.length ? [new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: W, height: headH, borderWidth: 0, borderColor: 0, paddingLength: PAD,
    containerID: 2, containerName: 'head', content: head.join('\n'), isEventCapture: 0,
  })] : []
  const items = (labels.length ? labels : ['(nothing)']).map(l => pxTruncate(l, W - 40).slice(0, 64))
  await page(texts, new ListContainerProperty({
    xPosition: 0, yPosition: headH, width: W, height: Math.min(H - headH, items.length * ITEM_PX), borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: 3, containerName: 'list', isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items }),
  }))
  layout = 'list'
}

/** A page of a long list, and what each row on it means. */
function paged(all: string[], pageNo: number) {
  if (all.length <= LIST_MAX) return { labels: all, at: (i: number) => ({ index: i }) as { index?: number; page?: number } }
  const start = pageNo * PER_PAGE
  const prev = pageNo > 0
  const next = start + PER_PAGE < all.length
  const labels = [...(prev ? ['Previous page'] : []), ...all.slice(start, start + PER_PAGE), ...(next ? ['Next page'] : [])]
  const at = (i: number): { index?: number; page?: number } =>
    prev && i === 0 ? { page: pageNo - 1 } : next && i === labels.length - 1 ? { page: pageNo + 1 } : { index: start + i - (prev ? 1 : 0) }
  return { labels, at }
}

function outputHeader(v: Extract<View, { kind: 'output' }>): string {
  const suffix = (v.parts.length > 1 ? `  part ${v.part + 1} of ${v.parts.length}` : '')
    + (v.running ? ' · running' : '') + (v.note ? ` · ${v.note}` : '')
  return pxTruncate(v.title, INNER - getTextWidth(suffix)) + suffix
}

/** Draws the current view. If the glasses don't answer (Bluetooth hiccup, slow start), redraws from scratch
 * 2 s later instead of leaving them blank or stale. */
async function render() {
  clearTimeout(retry)
  try {
    await draw()
  } catch (e) {
    console.warn('The glasses did not answer; drawing again shortly.', e)
    if (!started) createTimedOut = true
    layout = null
    retry = setTimeout(() => void render(), 2000)
  }
}

async function draw() {
  const v = view
  if (v.kind === 'list') await showList('Scripts', paged(store.ordered().map(s => s.name), v.page).labels)
  else if (v.kind === 'choice') {
    const title = [v.choice.title, v.choice.message].filter(Boolean).join(' - ')
    await showList(title, paged(v.choice.options, v.page).labels)
  } else if (v.kind === 'output') await showOutput(outputHeader(v), v.parts[v.part])
  else if (v.kind === 'busy') await showText(`${v.title}\n\nRunning...${v.note ? `\n${v.note}` : ''}`)
  else await showText(v.text)
}

export async function showRoot() {
  const checked = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  view = store.scripts.length ? { kind: 'list', page: 0 }
    : { kind: 'message', text: `No scripts yet.\n\nAdd one on your phone: open this app in the Even app and tap New script.\n\nTap to check again (checked ${checked}).` }
  await render()
}

/** Re-draws the current screen from scratch (after scripts or favourites changed on the phone). */
export async function refresh() {
  layout = null
  if (view.kind === 'list' || view.kind === 'message') await showRoot()
  else await render()
}

function stopRun() {
  if (view.kind === 'choice') view.resolve(-1)
  run?.abort()
  run = null
  runSeq++
  clearTimeout(liveTimer)
}

/** Output a script shows while it is still running; redrawn at most once a second, the latest wins. */
function live(title: string, scriptId: string, output: RunResult['output']) {
  const part = view.kind === 'output' && view.scriptId === scriptId ? view.part : 0
  const parts = toParts(output.text)
  view = { kind: 'output', title, parts, part: Math.min(part, parts.length - 1), scriptId, running: true }
  clearTimeout(liveTimer)
  liveTimer = setTimeout(() => { liveLast = Date.now(); void render() }, Math.max(0, 1000 - (Date.now() - liveLast)))
}

export async function runOnGlasses(id: string, mode: 'app' | 'widget' = 'app') {
  stopRun()
  const seq = runSeq
  const meta = store.scripts.find(s => s.id === id)
  if (!meta) return showRoot()
  view = { kind: 'busy', title: meta.name, since: Date.now() }
  await render()
  const handle = await startRun(id, {
    present: choice => new Promise<number>(resolve => {
      view = { kind: 'choice', choice, page: 0, resolve: i => { view = { kind: 'busy', title: meta.name, since: Date.now() }; void render(); resolve(i) } }
      void render()
    }),
    log: (level, text) => events.onLog(level, text),
    show: output => { if (seq === runSeq) live(meta.name, id, output) },
  }, mode)
  if (seq !== runSeq) return handle.abort() // stopped or replaced while starting
  run = handle
  const r = await handle.result
  if (seq !== runSeq) return // stopped or replaced by another run
  run = null
  clearTimeout(liveTimer)
  events.onResult(meta.name, r)
  const text = r.error ? `Error: ${r.error}${r.output.text ? `\n\n${r.output.text}` : ''}` : r.output.text || 'Done (no output).'
  view = { kind: 'output', title: meta.name, parts: toParts(text), part: 0, scriptId: id }
  await render()
}

async function back() {
  if (view.kind === 'choice') return view.resolve(-1)
  if (view.kind === 'busy' || view.kind === 'output') {
    stopRun()
    return showRoot()
  }
  await call(b => b.shutDownPageContainer(1)) // root: Even's exit dialog
}

async function pick(i: number) {
  const v = view
  if (v.kind === 'list') {
    const ordered = store.ordered()
    const r = paged(ordered.map(s => s.name), v.page).at(i)
    if (r.page != null) {
      view = { kind: 'list', page: r.page }
      return render()
    }
    const s = ordered[r.index ?? -1]
    if (s) return runOnGlasses(s.id)
  } else if (v.kind === 'choice') {
    const r = paged(v.choice.options, v.page).at(i)
    if (r.page != null) {
      view = { ...v, page: r.page }
      return render()
    }
    v.resolve(r.index ?? -1)
  }
}

// Every gesture gets a visible answer (Even's review rule), even where there is nothing to do.
// While the output overflows its box the glasses scroll it themselves and send no event; a swipe event
// means the box is at its top or end, so it moves to the previous or next part, or says "top"/"end".
async function scroll(dir: 1 | -1) {
  const v = view
  if (v.kind === 'busy' || v.kind === 'message') return nudge()
  if (v.kind !== 'output') return
  const part = v.part + dir
  if (part >= 0 && part < v.parts.length) {
    v.part = part
    v.note = undefined
  } else v.note = dir < 0 ? 'top' : 'end'
  await render()
}

async function nudge() {
  if (view.kind === 'message') return showRoot()
  if (view.kind !== 'busy') return
  view.note = `Still running, ${Math.round((Date.now() - view.since) / 1000)} s. Double-tap to stop.`
  await render()
}

async function tap() {
  if (view.kind === 'output') return runOnGlasses(view.scriptId)
  return nudge()
}

// A tap arrives without an eventType (protobuf drops the 0), so it is resolved inside the envelope.
const typeOf = (env?: { eventType?: number }) => (env ? env.eventType ?? OsEventTypeList.CLICK_EVENT : null)

async function onEvent(e: EvenHubEvent) {
  if (e.menuItemClickEvent) {
    const id = e.menuItemClickEvent.itemID ?? 0
    if (id === MENU_ALL) {
      stopRun()
      return showRoot()
    }
    if (id === MENU_NEXT) return scroll(1)
    if (id === MENU_PREV) return scroll(-1)
    const fav = menuFavIds[id - MENU_FAV]
    if (fav) return runOnGlasses(fav)
    return
  }
  const sys = typeOf(e.sysEvent)
  const text = typeOf(e.textEvent)
  if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || text === OsEventTypeList.DOUBLE_CLICK_EVENT) return back()
  if (e.listEvent) {
    if ((e.listEvent.eventType ?? OsEventTypeList.CLICK_EVENT) === OsEventTypeList.CLICK_EVENT) return pick(e.listEvent.currentSelectItemIndex ?? 0)
    return
  }
  if (text === OsEventTypeList.SCROLL_TOP_EVENT) return scroll(-1)
  if (text === OsEventTypeList.SCROLL_BOTTOM_EVENT) return scroll(1)
  if (sys === OsEventTypeList.CLICK_EVENT || text === OsEventTypeList.CLICK_EVENT) return tap()
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) stopRun()
  // Foreground enter/exit (also fired by opening/closing the menu) and long presses: nothing to do.
}

export async function start() {
  bridge.onEvenHubEvent(e => { onEvent(e).catch(err => console.error('glasses event failed', err)) })
  const startId = store.startId
  if (startId && store.scripts.some(s => s.id === startId)) await runOnGlasses(startId)
  else await showRoot()
}
