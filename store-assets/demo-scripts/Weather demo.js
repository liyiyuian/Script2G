// Demo: a weather widget with made-up numbers (a real one would fetch a weather API through the bridge).
const w = new ListWidget()
w.addText("Springfield · Partly cloudy")
const now = w.addStack(); now.addText("Now 18°C"); now.addSpacer(); now.addText("H 21° / L 12°")
w.addText("Rain 20% · Wind 9 km/h")
for (const [h, t] of [["3 PM", "20°"], ["6 PM", "17°"], ["9 PM", "14°"]]) {
  const row = w.addStack(); row.addText(h); row.addSpacer(); row.addText(t)
}
Script.setWidget(w)
