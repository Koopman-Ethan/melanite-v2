import { sql } from 'drizzle-orm'
import { db } from './db'
async function main() {
  for (let i = 1; i <= 3; i++) {
    const t = process.hrtime.bigint()
    await db.execute(sql`select count(*)::int as n from providers`)
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    console.log(`query ${i}: ${ms.toFixed(0)} ms`)
  }
}
main()
