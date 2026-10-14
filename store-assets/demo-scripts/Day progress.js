// Demo: how far through the day, week, month and year we are (a widget).
const now = new Date()
const bar = (p) => "━".repeat(Math.round(p / 5)) + "─".repeat(20 - Math.round(p / 5))
const pct = (a, b) => Math.round(((now - a) / (b - a)) * 100)
const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
const week = new Date(day); week.setDate(day.getDate() - ((day.getDay() + 6) % 7))
const rows = [
  ["Today", pct(day, new Date(+day + 864e5))],
  ["This week", pct(week, new Date(+week + 7 * 864e5))],
  ["This month", pct(new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1))],
  ["This year", pct(new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1))],
]
const w = new ListWidget()
for (const [label, p] of rows) {
  const row = w.addStack()
  row.addText(label)
  row.addSpacer()
  row.addText(bar(p) + " " + p + "%")
}
Script.setWidget(w)
