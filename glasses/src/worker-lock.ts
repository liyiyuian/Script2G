// Imported FIRST by worker.ts, so this runs before the interpreter (sval) loads and copies the global names.
import { blockCodeFromText, blockNetwork } from './runtime/lockdown.ts'

blockNetwork()
blockCodeFromText()
