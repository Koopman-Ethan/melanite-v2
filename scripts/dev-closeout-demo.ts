import '../envConfig'

import { and, eq, like } from 'drizzle-orm'

import { bookings, endOfUseChecklists, providerServices, providers, services } from '@/lib/db/schema'
import {
  END_OF_USE_ITEMS,
  END_OF_USE_ITEM_COUNT,
  END_OF_USE_VERSION,
} from '@/lib/end-of-use'

import { describeDatabase, requireEnv } from '../lib/env-guard'
import { db } from './db'

// Fixtures for showing the end-of-use checklist to somebody.
//
//   npm run dev:closeout-demo
//
// WHY THIS EXISTS
//
// `refresh-dev.ts` replaces dev with a copy of production every night, so any booking seeded by
// hand is gone by morning — and so are the provider_service ids it was written against, which is
// the part that bites: a command pasted from yesterday fails on a stale uuid with an error about
// a foreign key rather than about being out of date.
//
// It had been done by hand three times before this existed. Same reasoning as
// `dev-e2e-credentials.ts`: the repair is necessary and a remembered one is not repeatable.
//
// IDEMPOTENT. Every row it writes is named `ZZ DEMO …`, the prefix `cleanup.teardown.ts` already
// sweeps, and it deletes its own before inserting. Re-run it as often as you like.
//
// NEVER IN PRODUCTION. Guarded by `requireEnv`, because this writes fictional appointments and a
// fictional device fault, and a fictional device fault in the real equipment log is worse than no
// demo at all.

const PREFIX = 'ZZ DEMO'

/** Hours back from now, as [start, end] pairs. The twelve-hour check window is what decides
 *  whether a session is still closeable, so these are placed either side of it deliberately. */
interface Seed {
  label: string
  client: string
  startHoursAgo: number
  endHoursAgo: number
  /** What to file against it, or null to leave it open. */
  closeout: null | {
    /** Conditional keys to tick on top of the required twenty. */
    alsoTick: string[]
    deviceIssue: string | null
    note: string | null
  }
  why: string
}

const REQUIRED_KEYS = END_OF_USE_ITEMS.filter((i) => i.required).map((i) => i.key)

const SEEDS: Seed[] = [
  {
    label: 'A',
    client: `${PREFIX} Ready to close out`,
    startHoursAgo: 2,
    endHoursAgo: 1,
    closeout: null,
    why: 'OPEN — the one to walk through live. Finished an hour ago, well inside the window.',
  },
  {
    label: 'B',
    client: `${PREFIX} Second one, spare`,
    startHoursAgo: 4,
    endHoursAgo: 3,
    closeout: null,
    why: 'OPEN — spare, or use it to demo reporting a device issue.',
  },
  {
    label: 'C',
    client: `${PREFIX} Quiet session`,
    startHoursAgo: 30,
    endHoursAgo: 29,
    closeout: { alsoTick: [], deviceIssue: null, note: null },
    why: 'CLOSED cleanly — all twenty required, nothing conditional. The ordinary case.',
  },
  {
    label: 'D',
    client: `${PREFIX} Chipped handpiece`,
    startHoursAgo: 32,
    endHoursAgo: 31,
    closeout: {
      alsoTick: ['docs_device_concerns'],
      deviceIssue: 'Handpiece window is chipped along one edge. Still fires, but worth a look.',
      note: null,
    },
    why: 'CLOSED with a device fault — fills the red "device issues" section on the admin page.',
  },
  {
    label: 'E',
    client: `${PREFIX} Ran short on gel`,
    startHoursAgo: 36,
    endHoursAgo: 35,
    closeout: {
      alsoTick: ['supplies_notify_shortage', 'docs_photos'],
      deviceIssue: null,
      note: 'Down to the last two bottles of gel.',
    },
    why: 'CLOSED with two conditionals ticked — fills the "What came up" block.',
  },
  {
    label: 'F',
    client: `${PREFIX} Nobody signed off`,
    startHoursAgo: 34,
    endHoursAgo: 33,
    closeout: null,
    why: 'MISSED — past the twelve-hour window with no close-out. Fills the amber exceptions list.',
  },
]

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60_000)
}

/** The laser is one shared resource behind an exclusion constraint, and dev carries real
 *  appointments copied from production. Walk back an hour at a time until a slot is free rather
 *  than failing on whoever happened to be booked. */
async function insertBooking(
  seed: Seed,
  providerId: string,
  providerServiceId: string,
): Promise<string> {
  let lastError: unknown

  for (let shift = 0; shift < 24; shift += 1) {
    try {
      const [row] = await db
        .insert(bookings)
        .values({
          providerId,
          providerServiceId,
          clientName: seed.client,
          originalPrice: '150.00',
          price: '150.00',
          paymentSource: 'checkout_link',
          durationMins: 60,
          startTime: hoursAgo(seed.startHoursAgo + shift),
          endTime: hoursAgo(seed.endHoursAgo + shift),
          status: 'completed',
        })
        .returning({ id: bookings.id })
      return row.id
    } catch (err) {
      if (!String(err).includes('bookings_no_overlap')) throw err
      lastError = err
    }
  }

  throw lastError ?? new Error(`could not place ${seed.client}`)
}

async function main() {
  // Dev only. This writes fictional appointments and a fictional device fault, and a fictional
  // fault sitting in the real equipment log is worse than having no demo at all.
  requireEnv(['dev'], 'seed demo close-outs')
  console.log(`Seeding ${describeDatabase()}\n`)

  const [provider] = await db
    .select({ id: providers.id, first: providers.firstName, last: providers.lastName })
    .from(providers)
    .where(eq(providers.email, 'nichole.mim@gmail.com'))
    .limit(1)

  if (!provider) {
    throw new Error('the e2e provider is missing — run `npm run dev:e2e-credentials` first')
  }

  const offered = await db
    .select({ id: providerServices.id, name: services.name })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(and(eq(providerServices.providerId, provider.id), eq(providerServices.isActive, true)))
    .orderBy(services.name)

  if (offered.length === 0) throw new Error('that provider offers no active services')

  // Its own rows, gone first, so re-running before a meeting is safe.
  const mine = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(like(bookings.clientName, `${PREFIX}%`))

  if (mine.length > 0) {
    for (const row of mine) {
      await db.delete(endOfUseChecklists).where(eq(endOfUseChecklists.bookingId, row.id))
      await db.delete(bookings).where(eq(bookings.id, row.id))
    }
    console.log(`  cleared   ${mine.length} row(s) from a previous run\n`)
  }

  for (const [i, seed] of SEEDS.entries()) {
    const service = offered[i % offered.length]
    const bookingId = await insertBooking(seed, provider.id, service.id)

    if (seed.closeout) {
      await db.insert(endOfUseChecklists).values({
        bookingId,
        providerId: provider.id,
        version: END_OF_USE_VERSION,
        completedItems: [...REQUIRED_KEYS, ...seed.closeout.alsoTick],
        itemCount: END_OF_USE_ITEM_COUNT,
        deviceIssue: seed.closeout.deviceIssue !== null,
        deviceIssueNote: seed.closeout.deviceIssue,
        note: seed.closeout.note,
      })
    }

    console.log(`  ${seed.label}  ${service.name}`)
    console.log(`     ${seed.why}\n`)
  }

  console.log(`Provider: ${provider.first} ${provider.last} (nichole.mim@gmail.com)`)
  console.log('Open /app/appointments as her, and /app/admin/equipment as the owner.')
}

main().catch((err) => {
  console.error('\nFAILED —', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
