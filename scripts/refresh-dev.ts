import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { neon } from '@neondatabase/serverless'

import '../envConfig'
import { describeDatabase, requireEnv } from '../lib/env-guard'
import { TABLES, scrubSql } from './scrub-sql'

// Replaces dev's contents with a scrubbed copy of production.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/refresh-dev.ts
//   npx tsx --tsconfig scripts/tsconfig.json scripts/refresh-dev.ts --dry-run
//
// Two connection strings, and they mean opposite things:
//
//   DATABASE_URL       the TARGET. Written to, destructively. Must be dev.
//   SOURCE_DATABASE_URL  production. Read from, and never written to.
//
// THE ONE THING THIS GETS RIGHT
//
// appdev.melanitesuite.com is publicly reachable, and production data is real clients: names,
// emails, phone numbers, treatment notes. A copy-then-scrub leaves a window — however
// short — in which that is exactly what appdev is serving, and a job that dies between the two
// steps leaves it that way until somebody notices.
//
// So the load and the scrub are ONE TRANSACTION. Readers see the previous contents until it
// commits and the scrubbed contents after; the real details exist inside the transaction and
// are never visible outside it. If anything fails at any point, the whole thing rolls back and
// dev is left exactly as it was — which is a stale copy, and stale is harmless.
//
// That also means no second database and no repointing of anything: no Neon branch to promote,
// no Vercel environment variable to swap, no redeploy. Postgres already provides the guarantee
// those mechanisms were going to approximate.
//
// WHAT IT DOES NOT DO
//
// Provider Connect ids are left as production wrote them, which means LIVE ids that appdev's
// test-mode Stripe key cannot see. `dev-connect-accounts.ts` fixes that and must run
// afterwards — it talks to the Stripe API, so it cannot be inside the transaction. That is a
// payments-are-broken problem for a few seconds, not a privacy one, which is why it is allowed
// to be outside.

const TARGET_ENV_VAR = 'DATABASE_URL'
const SOURCE_ENV_VAR = 'SOURCE_DATABASE_URL'

/** Host and database, never the credentials — this gets printed and logged. */
function describe(url: string): string {
  const match = /@([^/?]+)\/([^?]+)/.exec(url)
  return match ? `${match[1]}/${match[2]}` : 'an unparseable connection string'
}

function run(command: string, args: string[], options: { stdin?: string } = {}) {
  const result = spawnSync(command, args, {
    input: options.stdin,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })

  if (result.error) {
    const hint =
      (result.error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `\n  ${command} is not on PATH. Install the PostgreSQL client tools.`
        : ''
    throw new Error(`Could not run ${command}: ${result.error.message}${hint}`)
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status}\n${(result.stderr || result.stdout || '').trim()}`,
    )
  }

  return result.stdout
}

/**
 * Refuses to continue unless source and target are genuinely different databases.
 *
 * The failure this prevents is the expensive one. Point both variables at the same place — a
 * copied env file, a secret set once and forgotten — and the run truncates production and then
 * restores it from a dump of itself. That may even appear to work. It would also scrub every
 * real client's name and email out of the production database, permanently, and the ledger is
 * append-only precisely because that kind of thing cannot be tidied away afterwards.
 */
function assertDistinct(sourceUrl: string, targetUrl: string): void {
  if (describe(sourceUrl) === describe(targetUrl)) {
    throw new Error(
      [
        `Refusing to refresh: ${SOURCE_ENV_VAR} and ${TARGET_ENV_VAR} are the same database.`,
        ``,
        `  Both: ${describe(targetUrl)}`,
        ``,
        `  This would truncate it and then scrub every client's details out of it.`,
      ].join('\n'),
    )
  }
}

/**
 * Refuses to continue unless both databases are on the same migration.
 *
 * A data-only restore assumes the two schemas match. If they do not, the failure is not
 * always loud: a column dev does not have yet makes `pg_dump` output that errors on COPY, which
 * is fine, but a column dev has and production does not restores as NULL or a default, quietly.
 * Better to refuse and let somebody run the migration.
 */
async function assertSameSchema(sourceUrl: string, targetUrl: string): Promise<void> {
  const latest = async (url: string): Promise<string> => {
    const rows = (await neon(url)`
      SELECT coalesce(max(created_at)::text, 'none') AS v FROM drizzle.__drizzle_migrations
    `) as { v: string }[]
    return rows[0]?.v ?? 'none'
  }

  const [source, target] = await Promise.all([latest(sourceUrl), latest(targetUrl)])

  if (source !== target) {
    throw new Error(
      [
        `Refusing to refresh: the two databases are on different migrations.`,
        ``,
        `  ${describe(sourceUrl)} — ${source}`,
        `  ${describe(targetUrl)} — ${target}`,
        ``,
        `  Bring dev up to date first:  npm run db:migrate`,
      ].join('\n'),
    )
  }
}

/**
 * Confirms the target will let us turn foreign keys off for the session.
 *
 * `session_replication_role = replica` is what makes the restore order-independent — pg_dump
 * emits table data in an order that does not necessarily satisfy foreign keys, and there is no
 * deferring them because Drizzle does not declare them DEFERRABLE.
 *
 * Checked HERE, on an empty round trip, rather than discovered part-way through a restore. If
 * the role is not permitted to set it, that is a one-line answer at the start instead of a
 * half-applied transaction and a confusing error.
 */
async function assertCanDisableTriggers(targetUrl: string): Promise<void> {
  try {
    await neon(targetUrl)`SET session_replication_role = replica`
  } catch (err) {
    throw new Error(
      [
        `Refusing to refresh: this role cannot set session_replication_role on`,
        `  ${describe(targetUrl)}.`,
        ``,
        `  ${err instanceof Error ? err.message : String(err)}`,
        ``,
        `  Without it the restore has to satisfy foreign keys in pg_dump's output order, which`,
        `  it does not guarantee. Connect as the database owner.`,
      ].join('\n'),
    )
  }
}

/** Every public table, emptied. Written as a DO block so it does not need a hand-maintained
 *  list that would silently miss whatever the next migration adds. `drizzle.__drizzle_migrations`
 *  lives in its own schema and is therefore left alone, which is what we want — the schema
 *  version must survive the reload. */
const TRUNCATE_ALL = `
DO $$
DECLARE stmt text;
BEGIN
  SELECT 'TRUNCATE TABLE ' || string_agg(format('%I.%I', schemaname, tablename), ', ')
       || ' RESTART IDENTITY CASCADE'
    INTO stmt
    FROM pg_tables
   WHERE schemaname = 'public';

  IF stmt IS NOT NULL THEN EXECUTE stmt; END IF;
END $$;
`

async function main() {
  const targetUrl = process.env[TARGET_ENV_VAR]
  const sourceUrl = process.env[SOURCE_ENV_VAR]

  if (!targetUrl) throw new Error(`${TARGET_ENV_VAR} is not set`)
  if (!sourceUrl) {
    throw new Error(
      `${SOURCE_ENV_VAR} is not set — it must hold the PRODUCTION connection string, read-only`,
    )
  }

  // The target is what gets destroyed, so the guard is about the target. Stated, never sniffed:
  // see lib/env-guard.ts for why a connection string cannot be trusted to say.
  requireEnv(['dev'], `overwrite ${describeDatabase()} with a copy of production`)

  assertDistinct(sourceUrl, targetUrl)

  const dryRun = process.argv.includes('--dry-run')

  console.log(`  from  ${describe(sourceUrl)}  (read only)`)
  console.log(`  into  ${describe(targetUrl)}  (replaced)\n`)

  await assertSameSchema(sourceUrl, targetUrl)
  await assertCanDisableTriggers(targetUrl)
  console.log('Preflight passed — same migration, foreign keys can be deferred.\n')

  // --data-only: the schema is owned by the migrations, not by production. Restoring
  // production's schema would make dev's migration history a fiction.
  // --no-owner/--no-privileges: Neon roles differ between projects; grants do not travel.
  console.log('Dumping production…')
  const dump = run('pg_dump', [
    sourceUrl,
    '--data-only',
    '--schema=public',
    '--no-owner',
    '--no-privileges',
  ])
  console.log(`  ${(dump.length / 1024 / 1024).toFixed(1)} MB\n`)

  // One file, one transaction. psql --single-transaction wraps the whole thing, so the scrub
  // is not a separate step that could fail to happen — it is part of what "loaded" means.
  const script = [
    'SET session_replication_role = replica;',
    TRUNCATE_ALL,
    dump,
    '',
    '-- Scrubbed inside the same transaction as the load, so the real details are never',
    '-- visible to a reader of this database.',
    scrubSql(),
  ].join('\n')

  const dir = mkdtempSync(join(tmpdir(), 'melanite-refresh-'))
  const path = join(dir, 'refresh.sql')

  try {
    writeFileSync(path, script, 'utf8')

    if (dryRun) {
      console.log(`--dry-run: nothing was written to ${describe(targetUrl)}.`)
      console.log(`The transaction that would have run is ${script.length} bytes:\n`)
      console.log(`${script.slice(0, 600)}\n  …`)
      return
    }

    console.log('Loading and scrubbing, in one transaction…')
    run('psql', [
      targetUrl,
      '--single-transaction',
      '--quiet',
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--file',
      path,
    ])
  } finally {
    // The dump is real client data sitting on a disk. On a CI runner that disk goes away, but
    // this also runs on laptops.
    rmSync(dir, { recursive: true, force: true })
  }

  // Belt and braces. The scrub ran inside the transaction that committed, so this cannot fail
  // — which is exactly why it is worth asserting. If it ever does, the guarantee this whole
  // script exists for has broken, and finding that out here beats finding out from appdev.
  const sql = neon(targetUrl)
  let outstanding = 0
  for (const table of TABLES) {
    const [row] = (await sql.query(table.count)) as { n: number }[]
    outstanding += row.n
  }

  if (outstanding > 0) {
    throw new Error(
      [
        `LOADED BUT NOT SCRUBBED — ${outstanding} rows still hold real details.`,
        ``,
        `  ${describe(targetUrl)} is serving production data. Scrub it now:`,
        `    npm run db:scrub`,
      ].join('\n'),
    )
  }

  const [counts] = (await sql.query(
    `SELECT (SELECT count(*) FROM clients)::int  AS clients,
            (SELECT count(*) FROM bookings)::int AS bookings,
            (SELECT count(*) FROM ledger_entries)::int AS ledger`,
  )) as { clients: number; bookings: number; ledger: number }[]

  console.log(
    `\nDone. ${counts.clients} clients, ${counts.bookings} bookings, ` +
      `${counts.ledger} ledger entries — nothing identifying.`,
  )
  console.log('\nNow run:  npx tsx --tsconfig scripts/tsconfig.json scripts/dev-connect-accounts.ts')
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
