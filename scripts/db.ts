// Database client for scripts that run outside the Next.js runtime.
//
// `lib/db/index.ts` imports `server-only`, which correctly refuses to load in a plain Node
// process — that guard exists to stop the connection leaking into a client bundle and should
// stay. Scripts get their own client here instead, sharing the same schema and casing config.

import '../envConfig'

import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'

import * as schema from '@/lib/db/schema'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — add it to .env.local')
}

export const db = drizzle(neon(process.env.DATABASE_URL), {
  schema,
  casing: 'snake_case',
})
