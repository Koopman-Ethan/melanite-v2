import { readFileSync } from 'node:fs'

import { loadEnvConfig } from '@next/env'

import { parseEnvFile } from './lib/env-file'

// Loads .env* files the same way Next.js does, for tools that run outside the
// Next.js runtime (drizzle-kit reads .env.local through this).
loadEnvConfig(process.cwd())

// An explicitly named env file, for the handful of commands that must point somewhere other
// than the usual one — the production migration above all.
//
//   MELANITE_ENV_FILE=.env.migration npx tsx --tsconfig scripts/tsconfig.json scripts/etl/load.ts --i-know-this-is-production
//
// Deliberately NOT `.env.production.local`: Next loads that one itself whenever NODE_ENV is
// production, so a plain `next build` on this laptop would silently connect to the production
// database. A filename Next has never heard of cannot be picked up by accident — pointing at
// production has to be something you typed on the command line.
//
// These values WIN over .env.local, because overriding it is the entire point.
const overridePath = process.env.MELANITE_ENV_FILE
if (overridePath) {
  const values = parseEnvFile(readFileSync(overridePath, 'utf8'))
  for (const [key, value] of Object.entries(values)) process.env[key] = value

  // Says which file and which environment, every time. The whole risk here is running against
  // the wrong database while believing otherwise, so this is not noise.
  console.log(
    `[env] ${overridePath} loaded over .env.local — ` +
      `${Object.keys(values).length} values, MELANITE_ENV=${process.env.MELANITE_ENV ?? 'unset'}`,
  )
}
