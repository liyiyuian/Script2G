// Demo: days until a date given as the script's Parameter ("2027-01-01|New Year"), with a default.
const [date, title] = (args.widgetParameter || "2027-01-01|New Year").split("|")
const days = Math.ceil((new Date(date + "T00:00:00") - new Date()) / 864e5)
const w = new ListWidget()
w.addText(title)
w.addText(days + " days to go")
w.addDate(new Date(date + "T00:00:00")).applyDateStyle()
Script.setWidget(w)
