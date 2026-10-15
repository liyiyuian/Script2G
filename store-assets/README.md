# Script2G — store assets

Copy-and-paste material for the Even Hub listing. The agent prepares it; you upload it in the portal.

- `listing.txt` — name, tagline, short and full description, category, permission justification,
  privacy summary, terms.
- `tester-quickstart.txt` — ≤1000 characters; doubles as the Description for tester builds.
- `privacy.txt` — privacy policy. Linkable once the repo is public at
  `https://raw.githubusercontent.com/liyiyuian/evenScriptable/main/store-assets/privacy.txt`.
- `icon.svg` → `icon-512.png` — app icon (one green hue on dark, like the sibling apps). Uploaded in
  the portal; the manifest has no icon field. Re-export: `inkscape -w 512 -h 512 icon.svg -o icon-512.png`.
- `screenshots/` — 576×288 captures from the real Even Hub simulator, using only the app's preloaded
  example and the made-up demo scripts in `demo-scripts/` (never the owner's scripts or data). Re-create with
  `./capture_screenshots.sh`:
  1. `1-script-list.png` — the script list
  2. `2-time-of-day.png` — the example that comes with the app (Time of day), a widget shown as text
  3. `3-choice.png` — a UITable to pick from (Packing list)
  4. `4-long-list.png` — a long output that scrolls (Space launches)
  5. `5-weather.png` — another widget (Weather demo, made-up numbers)
- `release-notes-<version>.txt` — hub changelog (paste-ready) + full log for each build.
