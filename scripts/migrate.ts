// Applies pending migrations from ./drizzle.
//
// This exists because `drizzle-kit migrate` does nothing against this database: it prints
// "applying migrations…" and exits 0 with the journal untouched. The cause is the driver —
// drizzle-kit wraps a migration run in a transaction, and `@neondatabase/serverless` over HTTP
// has no interactive transactions, so the run is silently abandoned. A migration tool that
// reports success without applying anything is worse than one that fails.
//
// Statements are split on drizzle's own `--> statement-breakpoint` marker and sent one at a
// time. That is not merely a workaround: `ALTER TYPE … ADD VALUE` cannot be followed by a use
// of that value inside the same transaction, so statement-at-a-time is the only way migration
// 0008 could ever apply.
//
// Trade-off worth stating: without a transaction, a migration that fails halfway leaves the
// schema partly changed. Each statement is logged as it runs so the failure point is obvious,
// and migrations are recorded only after every statement in the file succeeds.
//
//   npm run db:migrate

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { db } from './db'

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

const DIR = join(process.cwd(), 'drizzle')

async function main() {
  const journal: { entries: JournalEntry[] } = JSON.parse(
    readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8'),
  )

  await db.execute(sql`create schema if not exists drizzle`)
  await db.execute(sql`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `)

  const applied = await db.execute<{ hash: string }>(
    sql`select hash from drizzle.__drizzle_migrations`,
  )
  const done = new Set(applied.rows.map((r) => r.hash))

  let ran = 0

  for (const entry of journal.entries) {
    // Line endings are normalised before hashing. Drizzle records the LF hash, and git in this
    // repo checks these files out as CRLF — hashing what is on disk marks every already-applied
    // migration as pending, which on a first run means replaying migration 0000 against a live
    // schema.
    const body = readFileSync(join(DIR, `${entry.tag}.sql`), 'utf8').replace(/\r\n/g, '\n')
    // Drizzle keys the journal on the file's hash, so an edited migration is a different
    // migration. Matching that exactly keeps `drizzle-kit` able to read this table.
    const hash = createHash('sha256').update(body).digest('hex')
    if (done.has(hash)) continue

    const statements = body
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== ';')

    console.log(`\n${entry.tag} — ${statements.length} statements`)

    for (const [i, statement] of statements.entries()) {
      const preview = statement.replace(/\s+/g, ' ').slice(0, 90)
      process.stdout.write(`  ${String(i + 1).padStart(2)}. ${preview}… `)
      await db.execute(sql.raw(statement))
      console.log('ok')
    }

    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${hash}, ${entry.when})`,
    )
    ran += 1
  }

  console.log(ran === 0 ? '\nNothing to apply.' : `\nApplied ${ran} migration(s).`)
}

main().catch((err) => {
  console.error('\nFAILED —', err instanceof Error ? err.message : err)
  console.error('The schema may be partly migrated. Fix the statement above and re-run.')
  process.exitCode = 1
})
