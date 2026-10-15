# Script2G

Run your own JavaScript scripts on **Even Realities G2** smart glasses. Add a script on your phone
(in the Even app), run it from the glasses. Many [Scriptable](https://scriptable.app) scripts run as
they are: widgets show as text, `Alert` and `UITable` become a list you pick from, live scripts update
while they run.

Inspired by Scriptable, the iOS automation app by Simon B. Støvring. This project is independent and
not affiliated with Scriptable or its developer.

## How it works

```
 phone (Even app)                                  your computer (optional)
 ┌──────────────────────────────┐   Tailscale    ┌──────────────────────────────┐
 │ glasses app (Even Hub plugin)│ ─────────────► │ scriptbridge (Python stdlib) │ ─► the web / local services
 │  scripts run in a Web Worker │  HTTPS + pwd   │  127.0.0.1:8795, tailnet-only│
 └──────────────┬───────────────┘                └──────────────────────────────┘
                │ Bluetooth (Even SDK)
          G2 glasses: text, lists, gestures
```

- **Scripts run on the phone**, in a Web Worker inside the plugin, with Scriptable-like globals. They run in a
  JavaScript interpreter ([sval](https://github.com/Siubaak/sval)), never as engine code: the app uses no `eval`
  or `new Function`, and scripts can't either. Everyday scripts are instant; tight loops run 20–100× slower than
  native JavaScript.
- The Even app only lets a plugin reach approved addresses and the WebView enforces CORS, so a script's
  `Request` goes through **scriptbridge**, a small server on your own computer, reachable only over your
  own Tailscale network and protected by a password. Scripts that don't fetch anything need no computer.

## Install the bridge (optional)

Needs Linux with `systemd --user`, Python 3.10+, and Tailscale (logged in; your phone on the same tailnet).

```bash
curl -fsSL https://raw.githubusercontent.com/liyiyuian/evenScriptable/main/bridge/install.sh | bash
```

It installs a `scriptbridge` user service, publishes it with `tailscale serve --https=8447` (asks for
sudo once), and prints an **address** and a **password**. Re-run it to upgrade (it keeps your password
and settings); `… | bash -s -- --uninstall` removes it. Settings: `~/.config/scriptbridge.env`.
`BRIDGE_SCRIPTS_DIR` is a folder of `.js` files the phone app can import (default `~/Scripts`).

## Use

1. Install the app from the Even Hub (needs the Even Realities app 2.2.10 or later; iPhone only for now).
2. Open it in the Even app. Under **Computer**, paste the bridge's address and password → **Save and test**.
3. **New script** (paste) or **Import** (from your computer). Put values scripts read with `Keychain.get`
   (API tokens) in the **Keychain** section. A script's **Parameter** is Scriptable's widget parameter.
4. On the glasses: **tap** = run, **swipe** = move / scroll, **double-tap** = back (on the list: exit).
   **Tap then hold** opens a menu with your starred scripts. On the phone, **☆** stars a script (top of the
   list + glasses menu); **Edit** has **Save and run on glasses**, **Open this script when the app starts** and
   **Delete script**.

## What works

| Scriptable | On the glasses |
|---|---|
| `ListWidget`, `WidgetStack`, text, dates | lines of text (styling, colours and drawings are dropped) |
| `Alert`, `UITable` | a list to pick from (typing isn't possible: text fields cancel) |
| `QuickLook`, `console.log` | text output |
| `Request` | through the bridge |
| `Keychain`, `FileManager` | the Even app's storage on the phone |
| `DateFormatter`, `RelativeDateTimeFormatter`, `Timer`, `UUID`, `Data`, `importModule`, `args.widgetParameter` | yes |
| `config.runsOnG2` | `true`, so a script can draw its own glasses layout |
| `Calendar`, `Reminder`, `Contact`, `Location`, `Photos`, `Notification`, `WebView`, `Speech`, … | not available (a clear error) |

## Security

- Anyone with the bridge password can make your computer fetch any address it can reach, including
  services on the computer itself (that is how a script can read a local feed). Keep it tailnet-only
  and keep the password secret.
- Scripts you add can read all Keychain values, import every other script (so a key written into one script
  is readable by the others) and use the bridge. Only add scripts you trust. Inside the app a script can't
  reach the web directly (the Worker's fetch, XMLHttpRequest, WebSocket, font and cache loading are removed, wherever
  they live); only through the bridge.
  Nor can it run code from text: `eval`, `new Function` (in every form), string timers and WebAssembly are
  turned off in the Worker before the interpreter loads.
- The bridge logs only the method, path and status of each request. It follows http/https redirects, and drops
  `Authorization` and `Cookie` when a redirect changes scheme, host or port.
- Keychain values are stored in the Even app's storage, not the iOS Keychain.
- A script that blocks for 15 s is stopped; a double-tap always stops a running script.

## Development

```
glasses/   the Even Hub plugin (Vite + TypeScript, official @evenrealities/even_hub_sdk)
bridge/    scriptbridge.py, install.sh, tests/
store-assets/  Even Hub listing, privacy policy, icon, screenshots (made from demo-scripts/)
```

```bash
cd glasses && npm install
npm test                              # runtime tests (node --test)
npm run compat -- <folder> [out.md]   # run a folder of Scriptable scripts, report what works
npm run build && npm run pack         # dist/ → .ehpk (stamps min app version from SDK 0.0.16)
cd ../bridge && python3 -m unittest discover tests && bash tests/test_install.sh
```

## License

MIT — see [LICENSE](LICENSE).

Bundles [sval](https://github.com/Siubaak/sval) 0.6.12 and its parser [acorn](https://github.com/acornjs/acorn),
both MIT-licensed. `glasses/scripts/patch-sval.mjs` fixes two sval bugs after `npm install` (a `return` inside
`try … finally`, and `for await` over an array of promises).
