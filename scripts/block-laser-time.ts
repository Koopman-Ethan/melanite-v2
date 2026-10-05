import { neon } from '@neondatabase/serverless'

import '../envConfig'
import { currentEnv, describeDatabase, requireEnv } from '../lib/env-guard'

// Closes a window of laser time so nobody can book it.
//
//   npm run block-laser-time -- --at 2026-10-06T16:30 --mins 60
//   npm run block-laser-time -- --at 2026-10-06T16:30 --mins 60 --apply
//
// Times are MOUNTAIN, written as the clock on the wall. The conversion happens in SQL —
// `(date + time) AT TIME ZONE 'America/Denver'` — which is the same expression
// `denverInstant` uses in `lib/db/queries/availability.ts`, and is DST-correct in a way that
// building a UTC offset by hand is not.
//
// WHY A BOOKING AND NOT SOMETHING PURPOSE-BUILT
//
// There is no blocked-time concept in this platform. Laser time is unavailable for exactly four
// reasons — outside operating hours, in the past, a booking in `upcoming`/`completed`, or a
// `scheduled` training course — and none of them means "Melanite has reserved this".
//
// Of the two that can be created on demand, a training course is out: `getUpcomingCourses` feeds
// the PUBLIC `/training` page with any scheduled course that has seats left, and a course must
// have at least one seat. A course invented to hold an hour would appear to the world as a real
// one that a stranger could enrol in and pay a deposit against.
//
// So: a booking under the house account. It is held by `bookings_no_overlap`, the GiST exclusion
// constraint that makes a single shared laser work, which means the block is enforced by the
// database rather than by every insert path remembering to check something.
//
// THIS IS A STOP-GAP. The real answer is a `blocked_time` table and a control on the admin
// calendar so Keoni does this herself; see the plan. Until then this is re-runnable and safe.
//
// ALLOWED AGAINST PRODUCTION, because that is the entire point — and refuses to write anything
// without `--apply`.

/** The service these blocks hang off. INACTIVE, so it can never be booked by anybody and never
 *  appears in a provider's service list — `getBookableServices` filters on `active`. */
const SERVICE_NAME = 'Reserved — Melanite'

/** What shows on the calendar where a client's name would be. */
const CLIENT_LABEL = 'Reserved — Melanite'

interface Window {
  /** `YYYY-MM-DD`, Denver. */
  date: string
  /** `HH:MM`, Denver. */
  time: string
  minutes: number
}

function parseWindows(argv: string[]): Window[] | { error: string } {
  const windows: Window[] = []

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--at') continue

    const at = argv[i + 1] ?? ''
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(at)
    if (!match) {
      return { error: `--at wants YYYY-MM-DDTHH:MM in Mountain time, got "${at}"` }
    }

    // `--mins` is read as the NEXT one after this `--at`, so several windows can be given in one
    // command and each keeps its own duration.
    const minsFlag = argv.indexOf('--mins', i)
    const minutes = minsFlag === -1 ? NaN : Number(argv[minsFlag + 1])
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 12 * 60) {
      return { error: `--at ${at} needs a --mins between 1 and 720` }
    }

    windows.push({ date: match[1], time: match[2], minutes })
  }

  return windows
}

async function main() {
  // Allowed in production deliberately. `--apply` is the guard that matters, not the environment.
  requireEnv(['dev', 'prod'], 'block laser time')

  const apply = process.argv.includes('--apply')
  const parsed = parseWindows(process.argv.slice(2))

  if ('error' in parsed) {
    console.error(parsed.error)
    process.exitCode = 1
    return
  }
  if (parsed.length === 0) {
    console.error('Nothing to block. Pass --at YYYY-MM-DDTHH:MM --mins N (repeatable).')
    process.exitCode = 1
    return
  }

  const sql = neon(process.env.DATABASE_URL!)
  console.log(`${describeDatabase()} (MELANITE_ENV=${currentEnv() ?? 'unset'})`)
  console.log(apply ? 'Mode: APPLY — time will be blocked\n' : 'Mode: dry run — nothing written\n')

  const [house] = (await sql.query(
    `SELECT id, first_name, last_name FROM providers WHERE revenue_model = 'house' LIMIT 1`,
  )) as { id: string; first_name: string; last_name: string }[]

  if (!house) {
    console.error('No house provider. A block has to belong to somebody; set one up first.')
    process.exitCode = 1
    return
  }

  let changes = 0
  let blocked = 0

  // ---- the service and the provider_service these hang off ----
  //
  // Created once and reused by every future block. Looked up by name, which has no unique index
  // in this schema, so inserts are guarded with NOT EXISTS the way `scripts/etl/catalogue.ts`
  // does it.
  let [service] = (await sql.query(`SELECT id FROM services WHERE name = $1`, [SERVICE_NAME])) as {
    id: string
  }[]

  if (!service) {
    changes += 1
    if (apply) {
      const rows = (await sql.query(
        `INSERT INTO services (name, category, suggested_duration_mins, min_duration_mins,
                               max_duration_mins, package_eligible, advanced_tier_required,
                               color_hex, active)
         VALUES ($1, 'Melanite', 60, 15, 720, false, false, '#6b7280', false)
         RETURNING id`,
        [SERVICE_NAME],
      )) as { id: string }[]
      service = rows[0]
      console.log(`  created  service "${SERVICE_NAME}" (inactive — nobody can book it)`)
    } else {
      console.log(`  missing  service "${SERVICE_NAME}" — would be created, inactive`)
    }
  }

  let providerService: { id: string } | undefined
  if (service) {
    ;[providerService] = (await sql.query(
      `SELECT id FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
      [house.id, service.id],
    )) as { id: string }[]

    if (!providerService) {
      changes += 1
      if (apply) {
        const rows = (await sql.query(
          `INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
           VALUES ($1, $2, '0.00', 60, false) RETURNING id`,
          [house.id, service.id],
        )) as { id: string }[]
        providerService = rows[0]
        console.log(`  created  ${house.first_name}'s link to it`)
      } else {
        console.log(`  missing  ${house.first_name}'s link to it — would be created`)
      }
    }
  }

  // ---- the windows ----
  for (const w of parsed) {
    const label = `${w.date} ${w.time} for ${w.minutes} min`

    // Already blocked? Matched on the exact window under the house account, so a re-run is a
    // no-op rather than a second overlapping row the constraint would reject anyway.
    if (providerService) {
      const existing = (await sql.query(
        `SELECT id FROM bookings
          WHERE provider_service_id = $1
            AND status IN ('upcoming', 'completed')
            AND start_time = (($2::date + $3::time) AT TIME ZONE 'America/Denver')
            AND end_time   = (($2::date + $3::time) AT TIME ZONE 'America/Denver')
                             + ($4 || ' minutes')::interval`,
        [providerService.id, w.date, w.time, String(w.minutes)],
      )) as { id: string }[]

      if (existing.length > 0) {
        console.log(`  ok       ${label} — already blocked`)
        blocked += 1
        continue
      }
    }

    // What is in the way. Reported BEFORE attempting the insert, because "Leyla has a Brazilian
    // at 16:45" is an answer somebody can act on and a constraint violation is not.
    const conflicts = (await sql.query(
      `SELECT p.first_name || ' ' || p.last_name AS who,
              s.name AS service,
              to_char(b.start_time AT TIME ZONE 'America/Denver', 'HH24:MI') AS starts,
              to_char(b.end_time   AT TIME ZONE 'America/Denver', 'HH24:MI') AS ends
         FROM bookings b
         JOIN providers p         ON p.id = b.provider_id
         JOIN provider_services ps ON ps.id = b.provider_service_id
         JOIN services s          ON s.id = ps.service_id
        WHERE b.status IN ('upcoming', 'completed')
          AND b.start_time < (($1::date + $2::time) AT TIME ZONE 'America/Denver')
                             + ($3 || ' minutes')::interval
          AND b.end_time   > (($1::date + $2::time) AT TIME ZONE 'America/Denver')
        ORDER BY b.start_time`,
      [w.date, w.time, String(w.minutes)],
    )) as { who: string; service: string; starts: string; ends: string }[]

    if (conflicts.length > 0) {
      console.error(`  BLOCKED  ${label} — something is already booked in that window:`)
      for (const c of conflicts) {
        console.error(`             ${c.starts}-${c.ends}  ${c.who} — ${c.service}`)
      }
      console.error('             Move or cancel it first; this will not book over an appointment.')
      process.exitCode = 1
      continue
    }

    changes += 1

    if (!apply) {
      console.log(`  would    block ${label}`)
      continue
    }

    if (!providerService) {
      console.error(`  FAILED   ${label} — no service to hang it off`)
      process.exitCode = 1
      continue
    }

    await sql.query(
      `INSERT INTO bookings
         (provider_id, provider_service_id, client_name, original_price, price, payment_source,
          duration_mins, start_time, end_time, status, notes)
       VALUES ($1, $2, $3, '0.00', '0.00', 'comped', $4::int,
               (($5::date + $6::time) AT TIME ZONE 'America/Denver'),
               (($5::date + $6::time) AT TIME ZONE 'America/Denver')
                 + ($4::text || ' minutes')::interval,
               'upcoming', $7)`,
      [
        house.id,
        providerService.id,
        CLIENT_LABEL,
        String(w.minutes),
        w.date,
        w.time,
        'Time blocked off by Melanite — not an appointment.',
      ],
    )

    blocked += 1
    console.log(`  blocked  ${label}`)
  }

  if (process.exitCode === 1) {
    // Said last, and loudly. A window that could not be blocked leaves real time open, and a
    // summary reporting only what worked is how that gets missed.
    console.error('\nSome windows were NOT blocked — see above. That time is still bookable.')
    return
  }

  if (changes === 0) {
    console.log(`\nNothing to do — ${blocked} window(s) already blocked.`)
    return
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to block ${changes} thing(s).`)
    return
  }

  console.log(`\n${blocked} window(s) blocked.`)
  console.log('To undo one, set its booking status to cancelled — the slot frees immediately.')
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
