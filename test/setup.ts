import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseEnvFile } from '@/lib/env-file'

// Loads .env.local into the test worker.
//
// Deliberately NOT via `@next/env`: it skips `.env.local` entirely when NODE_ENV is `test`,
// which is exactly what vitest sets. That is sensible for Next — it stops a dev database
// leaking into a test run — but here the dev database IS the test database, and the alternative
// is that every module touching it throws at import time with a message about a missing
// variable rather than a missing setup step.
//
// Parsing is shared with the migration env loader rather than written twice. The version that
// lived here matched with `$`, which does not match a line ending in `\r` — so the day the file
// was saved with Windows line endings, every variable silently vanished and 150 tests failed
// claiming DATABASE_URL was unset. One parser, with tests, is the fix for that class of thing.
const file = join(process.cwd(), '.env.local')

if (existsSync(file)) {
  const values = parseEnvFile(readFileSync(file, 'utf8'))

  for (const [key, value] of Object.entries(values)) {
    // A real environment variable wins, so a run can be pointed somewhere else deliberately.
    if (process.env[key] !== undefined) continue
    process.env[key] = value
  }
}
