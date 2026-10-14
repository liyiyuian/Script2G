// Demo: a table you pick from on the glasses (UITable).
const items = ["Passport", "Charger", "Headphones", "Rain jacket", "Book", "Snacks"]
const t = new UITable()
const head = new UITableRow(); head.isHeader = true; head.addText("Packing list: tap what you packed"); t.addRow(head)
for (const item of items) {
  const r = new UITableRow()
  r.addText(item)
  r.onSelect = () => console.log("Packed: " + item)
  t.addRow(r)
}
await t.present()
