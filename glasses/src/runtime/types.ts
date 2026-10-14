// Contract between the script runtime and whoever hosts it (the phone app's Worker, or Node tests).
// Kept free of DOM and SDK types so the same runtime runs in both places.

/** A web request, relayed by the user's bridge (the phone can't fetch arbitrary origins). */
export interface RelayRequest {
  url: string
  method: string
  headers: Record<string, string>
  bodyBase64?: string
  timeoutSec: number
}

export interface RelayResponse {
  status: number
  url: string
  headers: Record<string, string>
  bodyBase64: string
}

/** A list of choices shown on the glasses (Alert, UITable). */
export interface Choice {
  title: string
  message: string
  options: string[]
}

/** A FileManager file: text, or binary as base64 (`binary: true`), with its modification time (ms). */
export interface StoredFile {
  data: string
  binary?: boolean
  mtime: number
}

export interface Host {
  fetch(req: RelayRequest): Promise<RelayResponse>
  /** Resolves with the chosen option's index, or -1 when the user cancels (double-tap). */
  present(choice: Choice): Promise<number>
  log(level: 'log' | 'warn' | 'error', text: string): void
  keychainChanged(key: string, value: string | null): void
  fileChanged(path: string, value: StoredFile | null): void
}

export interface RunOptions {
  name: string
  runsInApp: boolean
  runsInWidget: boolean
  /** Key → value, read synchronously by Keychain. */
  keychain: Record<string, string>
  /** Path → contents, read synchronously by FileManager. */
  files: Record<string, StoredFile>
  /** Other scripts by name, for importModule. */
  modules: Record<string, string>
}

export interface RunResult {
  /** What to show on the glasses when the script ends. */
  output: { kind: 'widget' | 'text' | 'log' | 'none'; text: string }
  error?: string
  /** Scriptable APIs the script tried that G2 can't provide. */
  unsupported: string[]
  /** True when the script made a web request (needs the bridge on the phone). */
  usedNetwork: boolean
}
