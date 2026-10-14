// Startup: load what's stored on the phone, draw the phone page, then start the glasses.
import { store } from './store.ts'
import { mountPhone } from './phone.ts'
import { start } from './glasses.ts'

await store.load()
mountPhone(document.getElementById('app') as HTMLElement)
await start()
if (import.meta.env.DEV) (await import('./selftest.ts')).mountSelftest()
