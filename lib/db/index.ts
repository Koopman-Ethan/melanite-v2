import 'server-only'

import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'

import * as schema from './schema'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — add it to .env.local')
}

const sql = neon(process.env.DATABASE_URL)

export const db = drizzle(sql, { schema, casing: 'snake_case' })

export * from './schema'
