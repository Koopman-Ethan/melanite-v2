import 'server-only'

import { and, desc, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { paysRentSql } from '@/lib/db/revenue-model'
import { getProviderSharePct } from '@/lib/db/queries/admin-tools'
import {
  providerServices,
  providers,
  rentalFeeEntries,
  rentalFeeSchedules,
  services,
} from '@/lib/db/schema'
import { RENTAL_TIERS, tierForService, type RentalTier } from '@/lib/rental-fees'

// What Melanite charges to use the laser, as it currently stands.
//
// The live half of `lib/rental-fees.ts`. That file says what the tiers ARE and which service
// falls in which one; this says what each costs today, which Keoni edits in the admin.
//
// A PUBLISHED SCHEDULE IS IMMUTABLE. Editing writes a new version. That is what makes
// `providers.rentalScheduleVersion` meaningful: a provider accepted version 3, and version 3 is
// still there to be read. Mutating rows and keeping a change log would make the same question
// answerable only by replaying the log, which is not how you want to answer "what did they
// agree to pay".
//
// FALLING BACK TO THE SEED is deliberate and narrow. A tier added in code — a new treatment
// area, say — has no entry in the schedule that was published before it existed, and the
// alternative to falling back is a service nobody can book until Keoni happens to republish.
// The admin page says loudly when a tier is being priced this way, and publishing always writes
// every tier, so a fallback lasts until the next publish and no longer.

export interface ScheduleEntry {
  tierKey: string
  /** From `RENTAL_TIERS`, so a label change ships with the code that uses it. */
  label: string
  singleCents: number
  suggestedLowCents: number
  suggestedHighCents: number
  /** True when this came from the code seed because the published schedule has no entry. */
  fromSeed: boolean
}

export interface LiveSchedule {
  /** Null before anything has ever been published — the seeding script has not run. */
  version: number | null
  publishedAt: Date | null
  note: string | null
  entries: ScheduleEntry[]
  byTier: Map<string, ScheduleEntry>
  /** Tiers priced from code because the published version predates them. */
  seeded: string[]
}

function seedEntry(tier: RentalTier): ScheduleEntry {
  return {
    tierKey: tier.key,
    label: tier.label,
    singleCents: tier.singleCents,
    suggestedLowCents: tier.suggestedLowCents,
    suggestedHighCents: tier.suggestedHighCents,
    fromSeed: true,
  }
}

/**
 * The schedule in force.
 *
 * NOT memoised. It was wrapped in React's `cache` to save a query on the pages that read it
 * twice, which is at most two queries in the worst case — and in exchange the function behaved
 * differently inside a request and outside one, which made it awkward to test and would have
 * made a stale read possible in a background job. Two small queries is the better trade.
 *
 * Callers that price a whole list — the booking dropdown — should read this ONCE and resolve
 * tiers against `byTier` rather than calling `feeForService` per row.
 */
export async function getLiveSchedule(): Promise<LiveSchedule> {
  const [latest] = await db
    .select({
      version: rentalFeeSchedules.version,
      publishedAt: rentalFeeSchedules.publishedAt,
      note: rentalFeeSchedules.note,
    })
    .from(rentalFeeSchedules)
    .orderBy(desc(rentalFeeSchedules.version))
    .limit(1)

  const rows = latest
    ? await db
        .select({
          tierKey: rentalFeeEntries.tierKey,
          singleCents: rentalFeeEntries.singleCents,
          suggestedLowCents: rentalFeeEntries.suggestedLowCents,
          suggestedHighCents: rentalFeeEntries.suggestedHighCents,
        })
        .from(rentalFeeEntries)
        .where(eq(rentalFeeEntries.scheduleVersion, latest.version))
    : []

  const published = new Map(rows.map((r) => [r.tierKey, r]))

  // Driven by the code tier list, not by what is in the table. A tier that left the code is a
  // tier nothing maps to, so its price is unreachable and listing it would only invite somebody
  // to edit a number that can never be charged.
  const entries = RENTAL_TIERS.map((tier): ScheduleEntry => {
    const row = published.get(tier.key)
    if (!row) return seedEntry(tier)
    return {
      tierKey: tier.key,
      label: tier.label,
      singleCents: row.singleCents,
      suggestedLowCents: row.suggestedLowCents,
      suggestedHighCents: row.suggestedHighCents,
      fromSeed: false,
    }
  })

  return {
    version: latest?.version ?? null,
    publishedAt: latest?.publishedAt ?? null,
    note: latest?.note ?? null,
    entries,
    byTier: new Map(entries.map((e) => [e.tierKey, e])),
    seeded: entries.filter((e) => e.fromSeed).map((e) => e.tierKey),
  }
}

/**
 * What one session of this service costs a provider right now, in cents.
 *
 * The function application code should call. NULL means the service has no fee — see `UNPRICED`
 * in `lib/rental-fees.ts` — and is a refusal, never a free session.
 */
export async function feeForService(serviceName: string): Promise<number | null> {
  const tier = tierForService(serviceName)
  if (!tier) return null

  const schedule = await getLiveSchedule()
  return schedule.byTier.get(tier.key)?.singleCents ?? tier.singleCents
}

/**
 * What one session of this service costs THIS provider, in cents.
 *
 * The function application code should call wherever a provider is known. `feeForService` above
 * answers the published question; this one answers the only question that actually decides what
 * a card is charged.
 *
 * TWO BASES, ONE QUESTION. Most providers pay the published fee for the service's tier. Leyla,
 * Brittany and Karly pay half of what they themselves charge for it — the last trace of the
 * 50/50 they were grandfathered into, arrived at from the other direction now that they bill
 * their clients directly instead of through Melanite.
 *
 * NULL IS A REFUSAL, never a free session, and it means different things per basis:
 *   - `tier`: the service has no published fee (see `UNPRICED` in `lib/rental-fees.ts`)
 *   - `half_own_price`: the provider has not priced it on `/app/services`, so there is no half
 *     to take. Letting that through as zero would hand them an unlimited free session every
 *     time they left a price blank.
 *
 * The figure for a `half_own_price` provider is PROVISIONAL. Their price list is theirs to edit,
 * so this is what Melanite believes the session is worth, not what it settles for: Keoni
 * confirms every one of their sessions against a receipt before the card is touched. See the
 * `rent_to_confirm` queue, and `bookings.feeOverrideCents` for what she sets instead.
 */
export async function feeForProviderService(
  providerId: string,
  serviceName: string,
): Promise<number | null> {
  const [provider] = await db
    .select({ rentBasis: providers.rentBasis })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1)

  if (!provider) return null
  if (provider.rentBasis === 'tier') return feeForService(serviceName)

  return halfOwnPriceFor(providerId, serviceName)
}

/**
 * Half of what this provider charges for this service, from their own price list.
 *
 * Read from `provider_services.price`, which the rental model stopped reading and this brings
 * back as load-bearing. The share comes from `platform_settings.provider_share_pct` rather than
 * a hardcoded half, so the one number governs this and the ledger alike — and so Keoni can move
 * it without a deploy if the arrangement ever changes.
 *
 * Rounded in cents, like every other money calculation here, so a half of an odd price cannot
 * land a fraction of a penny out.
 */
export async function halfOwnPriceFor(
  providerId: string,
  serviceName: string,
): Promise<number | null> {
  const [row] = await db
    .select({ price: providerServices.price })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(providerServices.providerId, providerId),
        eq(services.name, serviceName),
        eq(providerServices.isActive, true),
      ),
    )
    .limit(1)

  const price = Number(row?.price ?? 0)
  if (!Number.isFinite(price) || price <= 0) return null

  const sharePct = await getProviderSharePct()
  const cents = Math.round(price * 100 * (1 - sharePct))
  return cents > 0 ? cents : null
}

/** The version a provider has to have accepted. Null when nothing is published yet, which
 *  means there is nothing to accept and the gate is open. */
export async function liveScheduleVersion(): Promise<number | null> {
  return (await getLiveSchedule()).version
}

export interface PublishInput {
  tierKey: string
  singleCents: number
  suggestedLowCents: number
  suggestedHighCents: number
}

export type PublishResult = { version: number } | { error: string }

/**
 * Publishes a new schedule.
 *
 * Writes EVERY tier, not only the changed ones, so a version is a complete picture of what was
 * in force rather than a patch somebody has to apply in their head. It also clears any
 * seed fallback, which is the other reason a full write matters.
 *
 * The validation here duplicates the table's check constraints on purpose: a constraint
 * violation surfaces as a database error with a constraint name in it, and the person reading
 * it typed a price into a form. These produce sentences instead. The constraints remain the
 * guarantee — this is the explanation.
 */
export async function publishSchedule(
  input: PublishInput[],
  note: string,
  publishedBy: string,
): Promise<PublishResult> {
  if (!note.trim()) {
    return { error: 'Say why the prices are changing — it is unanswerable later otherwise.' }
  }

  const known = new Set(RENTAL_TIERS.map((t) => t.key))
  const byKey = new Map(input.map((e) => [e.tierKey, e]))

  for (const entry of input) {
    const tier = RENTAL_TIERS.find((t) => t.key === entry.tierKey)
    if (!tier) return { error: `There is no tier called ${entry.tierKey}.` }

    if (!Number.isInteger(entry.singleCents) || entry.singleCents <= 0) {
      return { error: `${tier.label} needs a fee above zero.` }
    }
    if (entry.suggestedHighCents < entry.suggestedLowCents) {
      return { error: `${tier.label} has its suggested range the wrong way round.` }
    }
    if (entry.singleCents >= entry.suggestedLowCents) {
      // The model is that the fee is roughly half of market and the provider keeps the rest.
      // A fee at or above what the treatment sells for is renting at a loss.
      return {
        error:
          `${tier.label}: a $${(entry.singleCents / 100).toFixed(2)} fee is not below the ` +
          `$${(entry.suggestedLowCents / 100).toFixed(2)} the treatment sells for. ` +
          'Lower the fee, or raise the suggested price if the market has moved.',
      }
    }
  }

  const missing = [...known].filter((k) => !byKey.has(k))
  if (missing.length > 0) {
    // A partial publish would leave the missing tiers falling back to the seed, silently
    // undoing a previous edit to them.
    return { error: `Every tier has to be priced. Missing: ${missing.join(', ')}.` }
  }

  const [current] = await db
    .select({ version: rentalFeeSchedules.version })
    .from(rentalFeeSchedules)
    .orderBy(desc(rentalFeeSchedules.version))
    .limit(1)

  const version = (current?.version ?? 0) + 1

  // One statement. Two admins pressing Publish at the same moment compute the same version and
  // one loses on the primary key, which is the right outcome — the loser reloads and sees the
  // other's change rather than silently overwriting it.
  await db.execute(sql`
    WITH s AS (
      INSERT INTO rental_fee_schedules (version, published_by, note)
      VALUES (${version}, ${publishedBy}::uuid, ${note.trim()})
      RETURNING version
    )
    INSERT INTO rental_fee_entries
      (schedule_version, tier_key, single_cents, suggested_low_cents, suggested_high_cents)
    SELECT s.version, e.tier_key, e.single_cents, e.low_cents, e.high_cents
      FROM s, unnest(
        ${sql.param(input.map((e) => e.tierKey))}::text[],
        ${sql.param(input.map((e) => e.singleCents))}::int[],
        ${sql.param(input.map((e) => e.suggestedLowCents))}::int[],
        ${sql.param(input.map((e) => e.suggestedHighCents))}::int[]
      ) AS e(tier_key, single_cents, low_cents, high_cents)
  `)

  return { version }
}

/** How many providers would have to accept a change before they could book again. */
export async function providersNeedingReacceptance(): Promise<number> {
  const live = await liveScheduleVersion()

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sql`providers`)
    .where(
      and(
        // Only a provider who pays rent is governed by the schedule. The 50/50 three never
        // see a rental fee, so counting them here would tell Keoni three people are blocked on
        // terms that do not apply to them.
        paysRentSql(sql`revenue_model`),
        sql`status = 'active'`,
        sql`booking_enabled`,
        live === null
          ? sql`rental_schedule_version IS NOT NULL`
          : sql`rental_schedule_version IS DISTINCT FROM ${live}`,
      ),
    )

  return row?.n ?? 0
}
