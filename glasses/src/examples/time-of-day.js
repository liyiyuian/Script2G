// Time of day: the example that comes with the app. The date and time, then how far through the
// day, week, month and year we are. On the glasses, tap to run it again.
const now = new Date()
const df = new DateFormatter()
df.dateFormat = "EEEE, MMM d"
const bar = (p) => "━".repeat(Math.round(p / 5)) + "─".repeat(20 - Math.round(p / 5))
const pct = (from, to) => Math.round(((now - from) / (to - from)) * 100)
const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
const week = new Date(day)
week.setDate(day.getDate() - ((day.getDay() + 6) % 7)) // Monday
const rows = [
  ["Today", pct(day, new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1))],
  ["This week", pct(week, new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7))],
  ["This month", pct(new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1))],
  ["This year", pct(new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1))],
]

const w = new ListWidget()
w.addText(df.string(now) + " · " + now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))
for (const [label, p] of rows) {
  const row = w.addStack()
  row.addText(label)
  row.addSpacer()
  row.addText(bar(p) + " " + p + "%")
}
Script.setWidget(w)
