// Runs a Scriptable script with Scriptable-like globals. Network, choices on the glasses, logs and
// storage changes go through `Host`, so this file has no DOM or SDK dependency.
import Sval from 'sval'
import type { Host, RunOptions, RunResult, StoredFile } from './types.ts'
import { uuid } from './uuid.ts'
import { ListWidget, WidgetStack, makeListWidget, widgetLines } from './widgets.ts'

const noop = () => {}
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

class Data {
  bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }
  static fromString(s: string) { return new Data(new TextEncoder().encode(String(s))) }
  static fromBase64String(b64: string) { return new Data(fromBase64(b64)) }
  toRawString() { return new TextDecoder().decode(this.bytes) }
  toBase64String() { return toBase64(this.bytes) }
  getBytes() { return Array.from(this.bytes) }
}

class Size {
  width: number
  height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }
}

class Point {
  x: number
  y: number
  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
}

class Rect {
  x: number
  y: number
  width: number
  height: number
  constructor(x: number, y: number, width: number, height: number) {
    this.x = x
    this.y = y
    this.width = width
    this.height = height
  }
  get minX() { return this.x }
  get minY() { return this.y }
  get maxX() { return this.x + this.width }
  get maxY() { return this.y + this.height }
  get midX() { return this.x + this.width / 2 }
  get midY() { return this.y + this.height / 2 }
  get size() { return new Size(this.width, this.height) }
  get origin() { return new Point(this.x, this.y) }
}

class Color {
  hex: string
  alpha: number
  constructor(hex: string, alpha = 1) {
    this.hex = String(hex).replace('#', '')
    this.alpha = alpha
  }
  get red() { return parseInt(this.hex.slice(0, 2), 16) / 255 }
  get green() { return parseInt(this.hex.slice(2, 4), 16) / 255 }
  get blue() { return parseInt(this.hex.slice(4, 6), 16) / 255 }
  static dynamic(_light: Color, dark: Color) { return dark }
}
const NAMED_COLORS: Record<string, string> = {
  black: '000000', darkGray: '555555', lightGray: 'aaaaaa', white: 'ffffff', gray: '808080', red: 'ff0000',
  green: '00ff00', blue: '0000ff', cyan: '00ffff', yellow: 'ffff00', magenta: 'ff00ff', orange: 'ff8000',
  purple: '800080', brown: '996633', clear: '000000',
}
for (const [name, hex] of Object.entries(NAMED_COLORS)) {
  Object.assign(Color, { [name]: () => new Color(hex, name === 'clear' ? 0 : 1) })
}

class FontBase {
  name: string
  size: number
  constructor(name: string, size: number) {
    this.name = name
    this.size = size
  }
}
// Every Font.xxxFont(size) and text-style factory returns a Font; the glasses have one font anyway.
const Font = new Proxy(FontBase, {
  get: (t, p, r) => (typeof p === 'symbol' || p in t ? Reflect.get(t, p, r) : (size?: number) => new FontBase(String(p), size ?? 17)),
})

class LinearGradient {
  colors: Color[] = []
  locations: number[] = []
  startPoint = new Point(0, 0)
  endPoint = new Point(0, 1)
}

class ImageG2 {
  size = new Size(0, 0)
  static fromData() { return new ImageG2() }
  static fromFile() { return new ImageG2() }
}

/** An object whose unknown methods do nothing (drawing APIs: their result can't be shown as text). */
function inert<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (t, p, r) => (typeof p === 'symbol' || p in t ? Reflect.get(t, p, r) : noop),
  })
}

class DrawContext {
  size = new Size(200, 200)
  respectScreenScale = false
  opaque = true
  constructor() {
    return inert(this)
  }
  getImage() { return new ImageG2() }
}

class Path {
  constructor() {
    return inert(this)
  }
}

const SFSymbol = { named: (_name: string) => inert({ image: new ImageG2() }) }

function formatPattern(d: Date, pattern: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const month = (style: 'long' | 'short') => d.toLocaleString([], { month: style })
  const day = (style: 'long' | 'short') => d.toLocaleString([], { weekday: style })
  const h12 = d.getHours() % 12 || 12
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()), yy: String(d.getFullYear()).slice(-2), MMMM: month('long'), MMM: month('short'),
    MM: pad(d.getMonth() + 1), M: String(d.getMonth() + 1), dd: pad(d.getDate()), d: String(d.getDate()),
    EEEE: day('long'), EEE: day('short'), HH: pad(d.getHours()), H: String(d.getHours()), hh: pad(h12),
    h: String(h12), mm: pad(d.getMinutes()), m: String(d.getMinutes()), ss: pad(d.getSeconds()),
    s: String(d.getSeconds()), a: d.getHours() < 12 ? 'AM' : 'PM',
  }
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|m|ss|s|a|'[^']*'/g,
    tok => (tok.startsWith("'") ? tok.slice(1, -1) : map[tok]))
}

type Style = 'full' | 'long' | 'medium' | 'short' | undefined

class DateFormatter {
  dateFormat = ''
  locale: string | undefined = undefined
  private dateStyle: Style = undefined
  private timeStyle: Style = undefined
  useNoDateStyle() { this.dateStyle = undefined }
  useShortDateStyle() { this.dateStyle = 'short' }
  useMediumDateStyle() { this.dateStyle = 'medium' }
  useLongDateStyle() { this.dateStyle = 'long' }
  useFullDateStyle() { this.dateStyle = 'full' }
  useNoTimeStyle() { this.timeStyle = undefined }
  useShortTimeStyle() { this.timeStyle = 'short' }
  useMediumTimeStyle() { this.timeStyle = 'medium' }
  useLongTimeStyle() { this.timeStyle = 'long' }
  useFullTimeStyle() { this.timeStyle = 'full' }
  string(date: Date) {
    if (this.dateFormat) return formatPattern(date, this.dateFormat)
    return date.toLocaleString(this.locale, { dateStyle: this.dateStyle, timeStyle: this.timeStyle })
  }
  date(str: string) { return new Date(str) }
}

class RelativeDateTimeFormatter {
  locale: string | undefined = undefined
  private numeric: 'auto' | 'always' = 'auto'
  useNamedDateTimeStyle() { this.numeric = 'auto' }
  useNumericDateTimeStyle() { this.numeric = 'always' }
  string(date: Date, referenceDate: Date) {
    const secs = (date.getTime() - referenceDate.getTime()) / 1000
    const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
    const [unit, size] = units.find(([, s]) => Math.abs(secs) >= s) ?? ['second', 1]
    return new Intl.RelativeTimeFormat(this.locale, { numeric: this.numeric }).format(Math.round(secs / size), unit)
  }
}

class Timer {
  timeInterval = 0
  repeats = false
  private id: ReturnType<typeof setTimeout> | undefined = undefined
  schedule(fn: () => void) {
    this.id = this.repeats ? setInterval(fn, this.timeInterval) : setTimeout(fn, this.timeInterval)
  }
  invalidate() {
    clearTimeout(this.id)
    clearInterval(this.id)
  }
  static schedule(timeInterval: number, repeats: boolean, fn: () => void) {
    const t = new Timer()
    t.timeInterval = timeInterval
    t.repeats = repeats
    t.schedule(fn)
    return t
  }
}

// Scriptable APIs that need iOS itself (calendars, contacts, location…). Using one throws a clear error.
const UNAVAILABLE = ['Calendar', 'CalendarEvent', 'Reminder', 'Contact', 'ContactsContainer', 'ContactsGroup',
  'Location', 'Photos', 'Mail', 'Message', 'ShareSheet', 'DocumentPicker', 'CallbackURL', 'URLScheme', 'WebView',
  'Speech', 'Dictation', 'XMLParser', 'DatePicker', 'RecurrenceRule', 'Notification', 'Pasteboard', 'Safari']

const describe = (x: unknown): string => {
  if (typeof x === 'string') return x
  if (x instanceof Error) return x.message
  try {
    return JSON.stringify(x, null, 2) ?? String(x)
  } catch {
    return String(x)
  }
}

/** Runs a script's source in an interpreter, never as engine code (no eval or new Function), and returns what
 * its body returns. The body sits in a block, so a script's own `const config` or `class Path` shadows a
 * global instead of clashing with it. */
function interpret(src: string, globals: Record<string, unknown>, module: { exports: object }, isAsync: boolean): unknown {
  const vm = new Sval({ ecmaVer: 'latest', sourceType: 'script', sandBox: true })
  vm.import({ ...globals, __module: module })
  vm.run(`exports.result = (${isAsync ? 'async ' : ''}function (module, exports) {{\n${src}\n}})(__module, __module.exports)`)
  return vm.exports.result
}

export async function runScript(source: string, host: Host, opts: RunOptions): Promise<RunResult> {
  const unsupported = new Set<string>()
  const logs: string[] = []
  let widget: ListWidget | null = null
  let quickLook: string | null = null
  let shortcutOutput: string | null = null
  let usedNetwork = false

  const fail = (api: string): never => {
    unsupported.add(api)
    throw new Error(`${api} isn't available on the glasses`)
  }
  // Known members work; any other member is reported as unavailable when called.
  const partial = <T extends object>(name: string, obj: T): T => new Proxy(obj, {
    get: (t, p, r) => (typeof p === 'symbol' || p in t ? Reflect.get(t, p, r) : () => fail(`${name}.${String(p)}`)),
  })
  const unavailable = (name: string) => new Proxy(function () {}, {
    get: (t, p, r) => (typeof p === 'symbol' || p === 'prototype' ? Reflect.get(t, p, r) : () => fail(`${name}.${String(p)}`)),
    apply: () => fail(name),
    construct: () => fail(name),
  })

  const console = {
    log: (...a: unknown[]) => { const s = a.map(describe).join(' '); logs.push(s); host.log('log', s) },
    warn: (...a: unknown[]) => { const s = a.map(describe).join(' '); logs.push(s); host.log('warn', s) },
    error: (...a: unknown[]) => { const s = a.map(describe).join(' '); logs.push(s); host.log('error', s) },
  }

  class Request {
    url: string
    method = 'GET'
    headers: Record<string, string> = {}
    body: unknown = undefined
    timeoutInterval = 60
    allowInsecureRequest = false
    onRedirect: unknown = null
    response: Record<string, unknown> | null = null
    constructor(url: string) {
      this.url = url
    }
    private async send(): Promise<Uint8Array> {
      usedNetwork = true
      const body = this.body instanceof Data ? this.body.bytes
        : this.body == null ? undefined : new TextEncoder().encode(String(this.body))
      const r = await host.fetch({
        url: this.url, method: this.method, headers: this.headers,
        bodyBase64: body && toBase64(body), timeoutSec: this.timeoutInterval,
      })
      const mime = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
      this.response = { url: r.url, statusCode: r.status, mimeType: mime.split(';')[0], textEncodingName: 'utf-8', headers: r.headers, cookies: [] }
      return fromBase64(r.bodyBase64)
    }
    async load() { return new Data(await this.send()) }
    async loadString() { return new TextDecoder().decode(await this.send()) }
    async loadJSON() { return JSON.parse(new TextDecoder().decode(await this.send())) }
    async loadImage() {
      await this.send()
      return new ImageG2()
    }
    addParameterToMultipart() { fail('Request multipart') }
    addFileDataToMultipart() { fail('Request multipart') }
    addFileToMultipart() { fail('Request multipart') }
    addImageToMultipart() { fail('Request multipart') }
  }

  const kc: Record<string, string> = { ...opts.keychain }
  const Keychain = partial('Keychain', {
    contains: (k: string) => hasOwn(kc, k),
    get: (k: string) => {
      if (!hasOwn(kc, k)) throw new Error(`Keychain has no value for "${k}". Add it in the phone app's Keychain section.`)
      return kc[k]
    },
    set: (k: string, v: string) => {
      if (String(k) === '__proto__') throw new Error('Keychain: "__proto__" can\'t be used as a name.')
      kc[k] = String(v)
      host.keychainChanged(k, kc[k])
    },
    remove: (k: string) => {
      delete kc[k]
      host.keychainChanged(k, null)
    },
  })

  const files: Record<string, StoredFile> = { ...opts.files }
  const dirs = new Set(['/Documents', '/Library', '/Caches', '/tmp'])
  const norm = (p: string) => '/' + String(p).split('/').filter(Boolean).join('/')
  const isDir = (p: string) => dirs.has(norm(p)) || Object.keys(files).some(f => f.startsWith(norm(p) + '/'))
  const put = (p: string, f: StoredFile | null) => {
    if (f) files[norm(p)] = f
    else delete files[norm(p)]
    host.fileChanged(norm(p), f)
  }
  const getFile = (p: string) => {
    const f = files[norm(p)]
    if (!f) throw new Error(`No file at ${p}`)
    return f
  }
  const fm = partial('FileManager', {
    documentsDirectory: () => '/Documents',
    libraryDirectory: () => '/Library',
    cacheDirectory: () => '/Caches',
    temporaryDirectory: () => '/tmp',
    joinPath: (a: string, b: string) => `${String(a).replace(/\/+$/, '')}/${String(b).replace(/^\/+/, '')}`,
    fileExists: (p: string) => hasOwn(files, norm(p)) || isDir(p),
    isDirectory: (p: string) => isDir(p),
    createDirectory: (p: string) => { dirs.add(norm(p)) },
    readString: (p: string) => {
      const f = getFile(p)
      return f.binary ? new TextDecoder().decode(fromBase64(f.data)) : f.data
    },
    writeString: (p: string, s: string) => put(p, { data: String(s), mtime: Date.now() }),
    read: (p: string) => {
      const f = getFile(p)
      return f.binary ? Data.fromBase64String(f.data) : Data.fromString(f.data)
    },
    write: (p: string, d: Data) => put(p, { data: d.toBase64String(), binary: true, mtime: Date.now() }),
    remove: (p: string) => {
      for (const f of Object.keys(files)) if (f === norm(p) || f.startsWith(norm(p) + '/')) put(f, null)
      dirs.delete(norm(p))
    },
    copy: (from: string, to: string) => put(to, { ...getFile(from), mtime: Date.now() }),
    move: (from: string, to: string) => {
      put(to, { ...getFile(from), mtime: Date.now() })
      put(from, null)
    },
    listContents: (dir: string) => {
      const base = norm(dir) + '/'
      const names = [...Object.keys(files), ...dirs].filter(f => f.startsWith(base)).map(f => f.slice(base.length).split('/')[0])
      return [...new Set(names)]
    },
    fileName: (p: string, includeExtension = false) => {
      const base = norm(p).split('/').pop() ?? ''
      return includeExtension ? base : base.replace(/\.[^.]*$/, '')
    },
    fileExtension: (p: string) => /\.([^./]*)$/.exec(p)?.[1] ?? '',
    modificationDate: (p: string) => (files[norm(p)] ? new Date(files[norm(p)].mtime) : null),
    creationDate: (p: string) => (files[norm(p)] ? new Date(files[norm(p)].mtime) : null),
    isFileStoredIniCloud: () => false,
    isFileDownloaded: () => true,
    downloadFileFromiCloud: async () => {},
    readImage: () => new ImageG2(),
  })

  const choose = async (title: string, message: string, options: string[]) =>
    host.present({ title, message, options: options.map(o => String(o)) })

  class Alert {
    title = ''
    message = ''
    private actions: string[] = []
    private cancel: string | null = null
    private fields: string[] = []
    addAction(t: string) { this.actions.push(t) }
    addDestructiveAction(t: string) { this.actions.push(t) }
    addCancelAction(t: string) { this.cancel = t }
    addTextField(_placeholder = '', text = '') { return this.field(text) }
    addSecureTextField(_placeholder = '', text = '') { return this.field(text) }
    textFieldValue(i: number) { return this.fields[i] ?? '' }
    present() { return this.show() }
    presentAlert() { return this.show() }
    presentSheet() { return this.show() }
    private field(text: string) {
      this.fields.push(text)
      return inert({ text, placeholder: '', isSecure: false })
    }
    private async show() {
      if (this.fields.length) {
        unsupported.add('Alert text fields')
        host.log('warn', 'Typing isn\'t possible on the glasses, so this prompt was cancelled. Set values in the phone app\'s Keychain section.')
        return -1
      }
      const options = [...this.actions, ...(this.cancel ? [this.cancel] : [])]
      const i = await choose(this.title, this.message, options.length ? options : ['OK'])
      if (i >= 0 && i < this.actions.length) return i
      return options.length && (i < 0 || this.cancel) ? -1 : 0 // the cancel button, a double-tap, or the default OK
    }
  }

  class UITableCell {
    title = ''
    subtitle = ''
    onTap: (() => unknown) | null = null
    dismissOnTap = false
    widthWeight = 1
    titleColor: unknown = null
    subtitleColor: unknown = null
    titleFont: unknown = null
    subtitleFont: unknown = null
    leftAligned = noop
    centerAligned = noop
    rightAligned = noop
    static text(title = '', subtitle = '') { return Object.assign(new UITableCell(), { title, subtitle }) }
    static button(title = '') { return Object.assign(new UITableCell(), { title }) }
    static image() { return new UITableCell() }
    static imageAtURL() { return new UITableCell() }
  }

  class UITableRow {
    cells: UITableCell[] = []
    height = 44
    cellSpacing = 0
    isHeader = false
    dismissOnSelect = true
    onSelect: ((index: number) => unknown) | null = null
    backgroundColor: unknown = null
    addCell(c: UITableCell) { this.cells.push(c) }
    addText(title?: string, subtitle?: string) { return this.push(UITableCell.text(title, subtitle)) }
    addButton(title?: string) { return this.push(UITableCell.button(title)) }
    addImage() { return this.push(UITableCell.image()) }
    addImageAtURL() { return this.push(UITableCell.imageAtURL()) }
    private push(c: UITableCell) {
      this.cells.push(c)
      return c
    }
  }

  const rowText = (r: UITableRow) =>
    r.cells.map(c => [c.title, c.subtitle].filter(Boolean).join(' - ')).filter(Boolean).join('  ') || '-'

  class UITable {
    rows: UITableRow[] = []
    showSeparators = false
    addRow(r: UITableRow) { this.rows.push(r) }
    removeRow(r: UITableRow) { this.rows = this.rows.filter(x => x !== r) }
    removeAllRows() { this.rows = [] }
    reload() {}
    async present() {
      for (;;) {
        const header = this.rows.find(r => r.isHeader)
        const body = this.rows.filter(r => !r.isHeader)
        const i = await choose(header ? rowText(header) : '', '', body.length ? body.map(rowText) : ['(empty)'])
        const row = body[i]
        if (!row) return
        const button = row.cells.find(c => c.onTap)
        if (row.onSelect) {
          await row.onSelect(this.rows.indexOf(row))
          if (row.dismissOnSelect) return
        } else if (button?.onTap) {
          await button.onTap()
          if (button.dismissOnTap) return
        }
      }
    }
  }

  const globals: Record<string, unknown> = {
    console,
    args: {
      plainTexts: [], urls: [], fileURLs: [], images: [], queryParameters: {}, shortcutParameter: null, notification: null,
      widgetParameter: opts.parameter || null,
    },
    config: {
      runsInApp: opts.runsInApp, runsInWidget: opts.runsInWidget, runsInAccessoryWidget: false, runsInActionExtension: false,
      runsWithSiri: false, runsFromHomeScreen: false, runsInNotification: false,
      widgetFamily: opts.runsInWidget ? 'medium' : undefined, runsOnG2: true,
    },
    Script: partial('Script', {
      name: () => opts.name,
      complete: noop,
      setWidget: (w: ListWidget) => { widget = w },
      setShortcutOutput: (v: unknown) => { shortcutOutput = describe(v) },
    }),
    ListWidget: makeListWidget(w => { widget = w; host.show({ kind: 'widget', text: widgetLines(w).join('\n') }) }),
    WidgetStack, Color, Font, Size, Point, Rect, LinearGradient, Image: ImageG2, DrawContext, Path, SFSymbol,
    Data, Request, Keychain, Alert, UITable, UITableRow, UITableCell, DateFormatter, RelativeDateTimeFormatter, Timer,
    FileManager: partial('FileManager', { local: () => fm, iCloud: () => fm }),
    QuickLook: { present: async (item: unknown) => { quickLook = describe(item); host.show({ kind: 'text', text: quickLook }) } },
    UUID: { string: () => uuid().toUpperCase() },
    Device: partial('Device', {
      name: () => '', systemName: () => 'iOS', systemVersion: () => '', model: () => 'G2',
      isPhone: () => false, isPad: () => false, screenSize: () => new Size(576, 288),
      screenResolution: () => new Size(576, 288), screenScale: () => 1, isUsingDarkAppearance: () => true,
      locale: () => Intl.DateTimeFormat().resolvedOptions().locale,
      language: () => Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0],
      preferredLanguages: () => [Intl.DateTimeFormat().resolvedOptions().locale],
    }),
  }
  for (const name of UNAVAILABLE) globals[name] = unavailable(name)

  globals.importModule = (name: string) => {
    const key = String(name).replace(/\.js$/, '')
    const src = hasOwn(opts.modules, key) ? opts.modules[key] : null
    if (src == null) throw new Error(`importModule: there is no script named "${key}"`)
    const module = { exports: {} }
    interpret(src, globals, module, false)
    return module.exports
  }

  let error: string | undefined
  try {
    const module = { exports: {} }
    await interpret(source, globals, module, true)
  } catch (e) {
    error = e instanceof Error ? e.message : describe(e)
  }

  const output: RunResult['output'] = widget ? { kind: 'widget', text: widgetLines(widget).join('\n') }
    : quickLook != null ? { kind: 'text', text: quickLook }
    : shortcutOutput != null ? { kind: 'text', text: shortcutOutput }
    : logs.length ? { kind: 'log', text: logs.join('\n') }
    : { kind: 'none', text: '' }
  return { output, error, unsupported: [...unsupported], usedNetwork }
}

