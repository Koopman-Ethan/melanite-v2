// Applies pending migrations from ./drizzle, one statement at a time.
//
// `drizzle-kit migrate` works fine here for ordinary migrations, and `db:migrate:kit` still
// runs it. This exists for one specific case it cannot handle:
//
//   ALTER TYPE … ADD VALUE 'x';        -- adds an enum value
//   ALTER TABLE … SET DEFAULT 'x';     -- uses it
//
// Postgres refuses the second inside the same transaction (`55P04 unsafe use of new value`),
// and drizzle-kit wraps an entire run — every pending file — in one transaction. Splitting the
// statements across two migration files does not help, because both files are still in the
// same run. Sending statements separately is the only way such a migration applies.
//
// drizzle-kit also swallows that error and exits 0, which is how migration 0008 appeared to
// succeed while changing nothing. Reporting success without applying anything is worse than
// failing, so this logs every statement as it runs.
//
// Trade-off: with no surrounding transaction, a failure halfway leaves the schema partly
// changed. A migration is recorded only once all of its statements succeed, and the failing
// statement is printed. For migrations with no enum changes, `db:migrate:kit` is the safer one.
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

  const applied = await db.execute<{ hash: string; created_at: string }>(
    sql`select hash, created_at from drizzle.__drizzle_migrations`,
  )

  // Keyed on the journal's `when`, NOT on the file's hash.
  //
  // The hash is of the file's CONTENTS, and content is not stable. Two things break it:
  //
  //   1. Identical SQL. 0018 added `cherry_started_at` to `checkout_links`, 0019 dropped it,
  //      and 0023 added it back for a different reason — byte-for-byte the same statement, so
  //      the same hash. Keying on the hash alone made this runner SKIP 0023 and print "Nothing
  //      to apply", reporting success while changing nothing.
  //
  //   2. Line endings and later edits. Fourteen of the twenty-five migration files hash
  //      differently now than when production applied them. Keying on hash-plus-timestamp —
  //      the first attempt at fixing (1) — therefore treated all fourteen as NEVER APPLIED and
  //      tried to replay `0000_normal_tarantula` against a live 24-table schema. It failed
  //      safely on `CREATE TYPE … already exists`, but only by luck of which statement came
  //      first.
  //
  // `when` comes from the journal, is unique per entry, and never changes once written. It is
  // also exactly what drizzle-kit's own migrator compares on, so this table stays readable by
  // both. An edited migration is deliberately NOT re-applied: you add a new migration, you
  // never rewrite one that has run.
  const done = new Set(applied.rows.map((r) => String(r.created_at)))

  // A changed hash is not a reason to re-run, but it IS worth saying: it means the file on disk
  // is no longer what was applied, so reading it tells you what the database contains only if
  // nobody has edited it.
  const appliedHash = new Map(applied.rows.map((r) => [String(r.created_at), r.hash]))
  const edited: string[] = []

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

    if (done.has(String(entry.when))) {
      if (appliedHash.get(String(entry.when)) !== hash) edited.push(entry.tag)
      continue
    }

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
