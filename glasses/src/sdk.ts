// One serial queue for every Even bridge call, each with a timeout. Even's guidance: concurrent
// render + storage calls can crash the BLE link, and a flaky hop can hang a call for ~30 s.
import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

export const bridge: EvenAppBridge = await waitForEvenAppBridge()

let chain: Promise<unknown> = Promise.resolve()

export function call<T>(fn: (b: EvenAppBridge) => Promise<T>, ms = 8000): Promise<T> {
  const run = chain.then(() => Promise.race([
    fn(bridge),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The glasses did not answer in time')), ms)),
  ]))
  chain = run.catch(() => {})
  return run
}
