// Startup: load what's stored on the phone, draw the phone page, then start the glasses.
import { store } from './store.ts'
import { mountPhone } from './phone.ts'
import { start } from './glasses.ts'

await store.load()
mountPhone(document.getElementById('app') as HTMLElement)
await start()
// Device self-test: dev server, or a production build made with VITE_SELFTEST=1 (never the packed app).
if (import.meta.env.DEV || import.meta.env.VITE_SELFTEST === '1') await (await import('./selftest.ts')).mountSelftest()
