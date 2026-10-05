import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RENTAL_TIERS } from '@/lib/rental-fees'
import { hasAcceptedRentalTerms, RENTAL_TERMS_VERSION } from '@/lib/rental-terms'
import { feeForService, getLiveSchedule, publishSchedule } from '@/lib/rental/schedule'

// The fee schedule Keoni edits.
//
// This is the first thing in the platform where a figure somebody is charged can be changed
// through a form, so the tests are about the two properties that makes necessary:
//
//   A PUBLISHED VERSION IS IMMUTABLE. A provider accepted version 3, and version 3 has to still
//   be there to be read. Everything else about the design follows from that.
//
//   PUBLISHING CANNOT PRODUCE A SCHEDULE THAT CHARGES NONSENSE. The database constraints are
//   the guarantee; `publishSchedule` turns them into sentences first. Both are tested, because
//   a validation that only exists in the form is not a validation.
//
// Published versions are read back from SQL rather than asserted against fixed numbers. Other
// tests in this file publish too, and the suite has to be correct whatever order it runs in and
// whatever the database already held.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let adminId = ''
let baseline = 0
const publishedVersions: number[] = []

/** Every tier at its seeded price — the starting point each test edits one thing from. */
function fullSchedule() {
  return RENTAL_TIERS.map((t) => ({
    tierKey: t.key,
    singleCents: t.singleCents,
    suggestedLowCents: t.suggestedLowCents,
    suggestedHighCents: t.suggestedHighCents,
  }))
}

async function liveVersionFromSql(): Promise<number | null> {
  const rows = (await sql.query(
    `SELECT version FROM rental_fee_schedules ORDER BY version DESC LIMIT 1`,
  )) as { version: number }[]
  return rows[0] ? Number(rows[0].version) : null
}

async function publish(entries = fullSchedule(), note = 'ZZ test') {
  const out = await publishSchedule(entries, note, adminId)
  if ('version' in out) publishedVersions.push(out.version)
  return out
}

beforeAll(async () => {
  const [admin] = (await sql.query(
    `SELECT id FROM providers WHERE role IN ('platform_owner', 'developer') LIMIT 1`,
  )) as { id: string }[]
  adminId = admin.id
  baseline = (await liveVersionFromSql()) ?? 0
})

afterAll(async () => {
  // Only the versions this file created. Entries cascade.
  await sql.query(`DELETE FROM rental_fee_schedules WHERE version = ANY($1::int[])`, [
    publishedVersions,
  ])
})

describe('publishing', () => {
  it('writes a new version rather than changing the old one', async () => {
    const before = await liveVersionFromSql()
    const out = await publish()

    expect(out).toHaveProperty('version')
    if (!('version' in out)) return

    expect(out.version).toBe((before ?? 0) + 1)

    // The previous version is still readable, which is the whole point — a provider who
    // accepted it must be able to be shown what they accepted.
    if (before !== null) {
      const rows = (await sql.query(
        `SELECT count(*)::int AS n FROM rental_fee_entries WHERE schedule_version = $1`,
        [before],
      )) as { n: number }[]
      expect(rows[0].n).toBeGreaterThan(0)
    }
  })

  it('records who published it and why', async () => {
    const out = await publish(fullSchedule(), 'ZZ market review')
    if (!('version' in out)) throw new Error('publish failed')

    const [row] = (await sql.query(
      `SELECT published_by, note FROM rental_fee_schedules WHERE version = $1`,
      [out.version],
    )) as { published_by: string; note: string }[]

    expect(row.published_by).toBe(adminId)
    expect(row.note).toBe('ZZ market review')
  })

  it('charges the new price immediately', async () => {
    const edited = fullSchedule().map((e) =>
      e.tierKey === 'lhr_xs' ? { ...e, singleCents: 4200 } : e,
    )
    const out = await publish(edited)
    if (!('version' in out)) throw new Error('publish failed')

    const [row] = (await sql.query(
      `SELECT single_cents FROM rental_fee_entries
        WHERE schedule_version = $1 AND tier_key = 'lhr_xs'`,
      [out.version],
    )) as { single_cents: number }[]

    expect(Number(row.single_cents)).toBe(4200)
  })

  it('writes every tier, not only the changed ones', async () => {
    // A partial version would leave the omitted tiers falling back to the code seed, silently
    // undoing an earlier edit to them.
    const out = await publish()
    if (!('version' in out)) throw new Error('publish failed')

    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM rental_fee_entries WHERE schedule_version = $1`,
      [out.version],
    )) as { n: number }[]

    expect(row.n).toBe(RENTAL_TIERS.length)
  })
})

describe('what publishing refuses', () => {
  it('refuses a fee at or above what the treatment sells for', async () => {
    // Renting at a loss. The model is that the fee is about half of market and the provider
    // keeps the rest, so this is the invariant rather than a nicety.
    const bad = fullSchedule().map((e) =>
      e.tierKey === 'lhr_xs' ? { ...e, singleCents: e.suggestedLowCents } : e,
    )
    const out = await publishSchedule(bad, 'ZZ too high', adminId)
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/not below/i)
  })

  it('refuses a fee of zero', async () => {
    // A free session is the failure the whole schedule exists to prevent — it is not found
    // until the month's takings are short.
    const bad = fullSchedule().map((e) =>
      e.tierKey === 'lhr_xs' ? { ...e, singleCents: 0 } : e,
    )
    const out = await publishSchedule(bad, 'ZZ free', adminId)
    expect(out).toHaveProperty('error')
  })

  it('refuses a backwards suggested range', async () => {
    const bad = fullSchedule().map((e) =>
      e.tierKey === 'lhr_xs' ? { ...e, suggestedHighCents: e.suggestedLowCents - 1 } : e,
    )
    const out = await publishSchedule(bad, 'ZZ backwards', adminId)
    expect(out).toHaveProperty('error')
  })

  it('refuses a partial schedule', async () => {
    const out = await publishSchedule(fullSchedule().slice(0, 3), 'ZZ partial', adminId)
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/every tier/i)
  })

  it('refuses a tier the code does not know', async () => {
    const out = await publishSchedule(
      [...fullSchedule(), { tierKey: 'lhr_enormous', singleCents: 1, suggestedLowCents: 2, suggestedHighCents: 2 }],
      'ZZ unknown tier',
      adminId,
    )
    expect(out).toHaveProperty('error')
  })

  it('refuses a change with no reason given', async () => {
    // A price move with nothing recording why is unanswerable six months later.
    const out = await publishSchedule(fullSchedule(), '   ', adminId)
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/why/i)
  })

  it('refuses nonsense even if the validation is bypassed', async () => {
    // The constraints are the guarantee; everything above is the explanation. Asserted by
    // going round `publishSchedule` entirely.
    const version = baseline + 900
    await sql.query(
      `INSERT INTO rental_fee_schedules (version, note) VALUES ($1, 'ZZ raw')`,
      [version],
    )

    try {
      await expect(
        sql.query(
          `INSERT INTO rental_fee_entries
             (schedule_version, tier_key, single_cents, suggested_low_cents, suggested_high_cents)
           VALUES ($1, 'lhr_xs', 99999, 8000, 8000)`,
          [version],
        ),
      ).rejects.toThrow()
    } finally {
      // Removed here rather than in afterAll. A schedule row with no entries is the NEWEST
      // version while it exists, so every price in the suite would fall back to the seed and
      // the tests after this one would be asserting against the wrong thing.
      await sql.query(`DELETE FROM rental_fee_schedules WHERE version = $1`, [version])
    }
  })
})

describe('reading the live schedule', () => {
  it('prices a service from the published version', async () => {
    // Not asserting a specific figure — another test in this file may have published one. What
    // matters is that it comes from the table rather than the constants.
    const fee = await feeForService('Laser Hair Removal — Chin')
    const live = await liveVersionFromSql()

    const [row] = (await sql.query(
      `SELECT single_cents FROM rental_fee_entries
        WHERE schedule_version = $1 AND tier_key = 'lhr_xs'`,
      [live],
    )) as { single_cents: number }[]

    expect(fee).toBe(Number(row.single_cents))
  })

  it('still returns null for a service with no tier', async () => {
    expect(await feeForService('Massage')).toBeNull()
  })

  it('reports which tiers are falling back to the seed', async () => {
    // A tier added in code after the last publish. Bookable at the seeded price, but Keoni has
    // never seen it, so the admin page says so.
    const schedule = await getLiveSchedule()
    for (const key of schedule.seeded) {
      expect(RENTAL_TIERS.map((t) => t.key)).toContain(key)
    }
    expect(schedule.entries.length).toBe(RENTAL_TIERS.length)
  })
})

describe('what a provider has accepted', () => {
  const current = { rentalTermsVersion: RENTAL_TERMS_VERSION, rentalScheduleVersion: 7 }

  it('accepts somebody current on both', () => {
    expect(hasAcceptedRentalTerms(current, 7)).toBe(true)
  })

  it('refuses somebody who accepted an older schedule', () => {
    // The gate that makes a price change mean something. They agreed to v6's prices; v7 is a
    // different set of numbers and they have not seen them.
    expect(hasAcceptedRentalTerms(current, 8)).toBe(false)
  })

  it('refuses somebody who accepted older prose, whatever the schedule says', () => {
    expect(
      hasAcceptedRentalTerms({ rentalTermsVersion: '2026-01-01.v1', rentalScheduleVersion: 7 }, 7),
    ).toBe(false)
  })

  it('opens the gate when nothing has been published', () => {
    // Before the seeding script runs there is no schedule to be out of date with, and blocking
    // every booking because of that would be the wrong failure.
    expect(hasAcceptedRentalTerms({ rentalTermsVersion: RENTAL_TERMS_VERSION, rentalScheduleVersion: null }, null)).toBe(true)
  })
})
