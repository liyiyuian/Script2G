// Scriptable's widget classes, kept as a tree that is turned into lines of text for the glasses.
// Styling (fonts, colours, padding, alignment) is accepted and ignored: the G2 shows one font in green.

const noop = () => {}

class WidgetElement {
  url: string | undefined = undefined
}

export class WidgetText extends WidgetElement {
  text: string
  font: unknown = null
  textColor: unknown = null
  textOpacity = 1
  lineLimit = 0
  minimumScaleFactor = 1
  shadowColor: unknown = null
  shadowRadius = 0
  shadowOffset: unknown = null
  leftAlignText = noop
  centerAlignText = noop
  rightAlignText = noop
  constructor(text: string) {
    super()
    this.text = text
  }
}

export class WidgetDate extends WidgetText {
  date: Date
  style: 'time' | 'date' | 'relative' | 'offset' | 'timer' = 'date'
  applyTimeStyle = () => { this.style = 'time' }
  applyDateStyle = () => { this.style = 'date' }
  applyRelativeStyle = () => { this.style = 'relative' }
  applyOffsetStyle = () => { this.style = 'offset' }
  applyTimerStyle = () => { this.style = 'timer' }
  constructor(date: Date) {
    super('')
    this.date = date
  }
}

export class WidgetImage extends WidgetElement {
  image: unknown
  resizable = true
  imageSize: unknown = null
  imageOpacity = 1
  cornerRadius = 0
  borderWidth = 0
  borderColor: unknown = null
  containerRelativeShape = false
  tintColor: unknown = null
  leftAlignImage = noop
  centerAlignImage = noop
  rightAlignImage = noop
  applyFittingContentMode = noop
  applyFillingContentMode = noop
  constructor(image: unknown) {
    super()
    this.image = image
  }
}

export class WidgetSpacer {
  length: number | null
  constructor(length: number | null) {
    this.length = length
  }
}

type Child = WidgetText | WidgetImage | WidgetSpacer | WidgetStack

export class WidgetStack extends WidgetElement {
  children: Child[] = []
  vertical = false
  backgroundColor: unknown = null
  backgroundImage: unknown = null
  backgroundGradient: unknown = null
  spacing = 0
  size: unknown = null
  cornerRadius = 0
  borderWidth = 0
  borderColor: unknown = null
  setPadding = noop
  useDefaultPadding = noop
  topAlignContent = noop
  centerAlignContent = noop
  bottomAlignContent = noop
  layoutHorizontally = () => { this.vertical = false }
  layoutVertically = () => { this.vertical = true }
  addText(text: string) { return this.add(new WidgetText(String(text ?? ''))) }
  addDate(date: Date) { return this.add(new WidgetDate(date)) }
  addImage(image: unknown) { return this.add(new WidgetImage(image)) }
  addSpacer(length?: number) { return this.add(new WidgetSpacer(length ?? null)) }
  addStack() { return this.add(new WidgetStack()) }
  private add<T extends Child>(child: T): T {
    this.children.push(child)
    return child
  }
}

/** Created by scripts with `new ListWidget()`; `onPresent` receives it when shown. */
export function makeListWidget(onPresent: (w: ListWidget) => void) {
  return class ListWidgetG2 extends ListWidget {
    constructor() {
      super(onPresent)
    }
  }
}

export class ListWidget extends WidgetStack {
  refreshAfterDate: Date | null = null
  addAccessoryWidgetBackground = false
  private onPresent: (w: ListWidget) => void
  constructor(onPresent: (w: ListWidget) => void) {
    super()
    this.vertical = true
    this.onPresent = onPresent
  }
  presentSmall() { return this.present() }
  presentMedium() { return this.present() }
  presentLarge() { return this.present() }
  presentExtraLarge() { return this.present() }
  presentAccessoryCircular() { return this.present() }
  presentAccessoryInline() { return this.present() }
  presentAccessoryRectangular() { return this.present() }
  private present() {
    this.onPresent(this)
    return Promise.resolve()
  }
}

function dateText(d: WidgetDate): string {
  const date = d.date instanceof Date ? d.date : new Date(d.date)
  if (d.style === 'time') return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.style === 'date') return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  const mins = Math.round((date.getTime() - Date.now()) / 60000)
  if (d.style === 'timer') return `${Math.abs(mins)} min`
  if (d.style === 'offset') return `${mins >= 0 ? '+' : '-'}${Math.abs(mins)} min`
  return new Intl.RelativeTimeFormat([], { numeric: 'auto' }).format(
    Math.abs(mins) < 60 ? mins : Math.round(mins / 60), Math.abs(mins) < 60 ? 'minute' : 'hour')
}

/**
 * Lines of text for a widget tree. A vertical stack puts each child on its own line(s);
 * a horizontal stack joins its children on one line when each of them is a single line,
 * otherwise (side-by-side columns) it lists the columns one after another.
 */
export function widgetLines(node: Child): string[] {
  if (node instanceof WidgetDate) return [dateText(node)]
  if (node instanceof WidgetText) return node.text.split('\n').map(s => s.trim()).filter(Boolean)
  if (!(node instanceof WidgetStack)) return []
  const parts = node.children.map(widgetLines).filter(l => l.length > 0)
  if (node.vertical || parts.some(l => l.length > 1)) return parts.flat()
  return parts.length ? [parts.map(l => l[0]).join('  ')] : []
}
