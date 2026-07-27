import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Loads .env.local into the test worker.
//
// Deliberately NOT via `@next/env`: it skips `.env.local` entirely when NODE_ENV is `test`,
// which is exactly what vitest sets. That is sensible for Next — it stops a dev database
// leaking into a test run — but here the dev database IS the test database, and the alternative
// is that every module touching it throws at import time with a message about a missing
// variable rather than a missing setup step.
const file = join(process.cwd(), '.env.local')

if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue

    const [, key, raw] = match
    if (process.env[key] !== undefined) continue

    process.env[key] = raw.trim().replace(/^["']|["']$/g, '')
  }
}
