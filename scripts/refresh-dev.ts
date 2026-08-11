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
// The foreign keys are dropped and re-added inside that same transaction, because Neon refuses
// `session_replication_role` to every role including the database owner. See DROP_FOREIGN_KEYS.
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
 * Confirms this role can alter every public table, which is what dropping and re-adding the
 * foreign keys requires.
 *
 * Checked HERE, on one round trip, rather than discovered part-way through. A refusal at the
 * start is a one-line answer; the same refusal mid-transaction is a rollback and a confusing
 * error about a constraint nobody was thinking about.
 */
async function assertOwnsTables(targetUrl: string): Promise<void> {
  const rows = (await neon(targetUrl)`
    SELECT count(*)::int AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND NOT pg_has_role(current_user, c.relowner, 'USAGE')
  `) as { n: number }[]

  if (rows[0]?.n > 0) {
    throw new Error(
      [
        `Refusing to refresh: this role does not own ${rows[0].n} of the tables on`,
        `  ${describe(targetUrl)}.`,
        ``,
        `  The restore drops every foreign key and puts it back, which the table's owner`,
        `  must do. Connect as the owning role.`,
      ].join('\n'),
    )
  }
}

/**
 * Confirms `pg_dump` is at least as new as the server it is about to read.
 *
 * pg_dump refuses outright against a newer server, and it does so AFTER connecting — so without
 * this the failure lands in the middle of the run rather than in preflight. Nothing is written
 * either way, but "aborting because of server version mismatch" is a worse first thing to read
 * than a sentence naming both versions and where the client comes from.
 *
 * The trap it catches: Ubuntu's `/usr/bin/pg_dump` is postgresql-common's wrapper, which
 * resolves to the DEFAULT installed major, not the newest. Installing postgresql-client-18
 * beside the runner's preinstalled 16 is not enough on its own — the versioned directory has to
 * come first on PATH.
 */
async function assertPgDumpVersion(sourceUrl: string): Promise<void> {
  const clientMajor = Number(/(\d+)/.exec(run('pg_dump', ['--version']))?.[1])

  const rows = (await neon(sourceUrl)`
    SELECT current_setting('server_version') AS v
  `) as { v: string }[]
  const serverMajor = Number(/(\d+)/.exec(rows[0]?.v ?? '')?.[1])

  if (!Number.isFinite(clientMajor) || !Number.isFinite(serverMajor)) return

  if (clientMajor < serverMajor) {
    throw new Error(
      [
        `Refusing to refresh: pg_dump ${clientMajor} cannot read a PostgreSQL ${serverMajor} server.`,
        ``,
        `  server:  ${serverMajor} (${describe(sourceUrl)})`,
        `  pg_dump: ${clientMajor}`,
        ``,
        `  On Ubuntu, /usr/bin/pg_dump is a wrapper that picks the DEFAULT installed major, not`,
        `  the newest — installing a newer client is not enough. Put its directory first:`,
        `    echo /usr/lib/postgresql/${serverMajor}/bin >> "$GITHUB_PATH"`,
      ].join('\n'),
    )
  }
}

// MAKING THE RESTORE ORDER-INDEPENDENT, WITHOUT SUPERUSER.
//
// `pg_dump --data-only` emits tables in an order that does not necessarily satisfy foreign
// keys, so a straight restore can insert a child before its parent. The usual answer is
// `SET session_replication_role = replica`, and NEON REFUSES IT — permission denied even for
// the database owner, because it is a superuser-only parameter. Deferring is not available
// either: Drizzle does not declare its constraints DEFERRABLE.
//
// So the constraints come off and go back on, inside the same transaction. DDL is transactional
// in Postgres, so a failure anywhere leaves every one of them in place.
//
// This is better than what it replaces, not merely a workaround for it. Disabling triggers
// suppresses the CHECK; re-adding a constraint VALIDATES it. If the copy were referentially
// broken, `session_replication_role` would have loaded it silently and this refuses to commit.
//
// Read from the catalogue rather than a hand-written list, so a foreign key added by a future
// migration is carried automatically. There are no user triggers in this schema — verified —
// so foreign keys are the whole of the problem.
const DROP_FOREIGN_KEYS = `
CREATE TEMP TABLE _melanite_fks ON COMMIT DROP AS
  SELECT c.conrelid::regclass        AS tbl,
         c.conname                   AS name,
         pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE c.contype = 'f' AND n.nspname = 'public';

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM _melanite_fks LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.name);
  END LOOP;
END $$;
`

const RESTORE_FOREIGN_KEYS = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM _melanite_fks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.name, r.def);
  END LOOP;
END $$;
`

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
  await assertOwnsTables(targetUrl)
  await assertPgDumpVersion(sourceUrl)
  console.log('Preflight passed — same migration, table ownership, and pg_dump new enough.\n')

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
    '-- Foreign keys come off so the restore does not depend on pg_dump ordering them, and go',
    '-- back on below. Both inside this transaction, so they are never absent to anybody else.',
    DROP_FOREIGN_KEYS,
    TRUNCATE_ALL,
    dump,
    '',
    '-- Scrubbed inside the same transaction as the load, so the real details are never',
    '-- visible to a reader of this database.',
    scrubSql(),
    '',
    '-- Re-added last, AFTER the scrub, so validation runs against exactly what will be',
    '-- committed. This is the referential integrity check on the copy, not just cleanup.',
    RESTORE_FOREIGN_KEYS,
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
