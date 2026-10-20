import 'server-only'

import { and, desc, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { paysRentSql } from '@/lib/db/revenue-model'
import {
  providers,
  rentalFeeEntries,
  rentalFeeSchedules,
} from '@/lib/db/schema'
import { denverYmd, discountedCents, promotionFor, type Promotion } from '@/lib/promotions'
import { RENTAL_TIERS, tierForService, type RentalTier } from '@/lib/rental-fees'
import { validatePricesAgainstPromotions } from '@/lib/validate/promotion'

import { activePromotions, promotionsCovering } from './promotions'

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
export async function feeForService(
  serviceName: string,
  on: Date = new Date(),
  bookedAt: Date = new Date(),
): Promise<number | null> {
  const tier = tierForService(serviceName)
  if (!tier) return null

  const schedule = await getLiveSchedule()
  const listed = schedule.byTier.get(tier.key)?.singleCents ?? tier.singleCents

  // A PROMOTION IS RESOLVED AGAINST THE SESSION'S DATE, NOT TODAY, and that is what the `on`
  // parameter is for. Rent is charged about twelve hours after a session ends, so a Friday
  // evening session is swept on Saturday morning — if a promotion finished on the Friday,
  // asking "is one running now" would charge full price for a session that was quoted and
  // worked at the promotional rate. Every promotion's last day would do this.
  //
  // It defaults to now because most callers are asking the present-tense question ("what does
  // this cost"), and the three that know a real session date pass it.
  //
  // `bookedAt` IS THE OTHER EDGE: when the price was promised. It matters only for a promotion
  // Keoni ended early, which stops applying to new bookings while every booking already taken
  // keeps the figure it was quoted. A fresh quote is being promised now, so now is the default;
  // anything pricing a session already on the calendar passes that booking's own date.
  const promos = await promotionsCovering(on)
  return discountedCents(listed, promotionFor(tier.key, denverYmd(on), promos, bookedAt))
}

/**
 * What one session of this service costs THIS provider, in cents.
 *
 * The function application code should call wherever a provider is known. `feeForService` above
 * answers the published question; this one answers the only question that actually decides what
 * a card is charged.
 *
 * TWO BASES, AND ONLY ONE OF THEM HAS AN ANSWER. Most providers pay the published fee for the
 * service's tier. Leyla, Brittany and Karly have no derived fee at all: they send Keoni the
 * receipt for what they charged their client and she sets the figure by hand.
 *
 * NULL IS A REFUSAL, never a free session, and it means different things per basis:
 *   - `tier`: the service has no published fee (see `UNPRICED` in `lib/rental-fees.ts`)
 *   - `keoni_sets`: there is nothing to derive, by design. Null here is not a gap in the data,
 *     it is the correct and permanent answer, and `bookings.feeOverrideCents` is where the
 *     real figure comes from.
 *
 * IT USED TO RETURN HALF THEIR OWN LIST PRICE. That was dropped on 19 October: the list is
 * theirs to maintain, so the derived figure was the payer's own number wearing Melanite's
 * authority — accurate only while the list matched what the client was actually charged, which
 * Melanite has no way to see. Keoni decided she would rather read the receipt than track their
 * pricing. Returning null is the honest version of the same arrangement.
 *
 * A PROMOTION REDUCES THE `tier` ANSWER AND NOTHING ELSE. The three on `keoni_sets` have no
 * derived figure for one to reduce — Keoni reads their receipt and types what they owe, and if
 * she means to charge them less during a promotion she types less. Applying one on top of a
 * figure she set by hand would be overriding a decision with a rule.
 *
 * CALLERS MUST NOT FALL BACK TO THE TIER FEE on null for a `keoni_sets` provider. That is the
 * mistake this shape is meant to make impossible — quoting or charging them the published
 * schedule is charging them somebody else's price.
 */
export async function feeForProviderService(
  providerId: string,
  serviceName: string,
  on: Date = new Date(),
  bookedAt: Date = new Date(),
): Promise<number | null> {
  const [provider] = await db
    .select({ rentBasis: providers.rentBasis })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1)

  if (!provider) return null
  if (provider.rentBasis === 'tier') return feeForService(serviceName, on, bookedAt)

  // `keoni_sets`. Nothing to work out, and that is the whole arrangement.
  return null
}


/**
 * The promotion reducing this service on this date, and what it would have cost without one.
 *
 * FOR SAYING SO, not for pricing — `feeForService` has already applied it. This exists because
 * a receipt reading "$46.70 charged" with no account of why it is not the usual $62.12 invites
 * exactly the query the receipt was meant to prevent, and the name is the only part of a
 * promotion a provider ever sees.
 *
 * Null when nothing applies, which is the ordinary case and costs one indexed read.
 */
export async function promotionOnService(
  serviceName: string,
  on: Date,
  bookedAt: Date = new Date(),
): Promise<{ promotion: Promotion; listedCents: number } | null> {
  const tier = tierForService(serviceName)
  if (!tier) return null

  const promos = await promotionsCovering(on)
  const promotion = promotionFor(tier.key, denverYmd(on), promos, bookedAt)
  if (!promotion) return null

  const schedule = await getLiveSchedule()
  return {
    promotion,
    listedCents: schedule.byTier.get(tier.key)?.singleCents ?? tier.singleCents,
  }
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

  // THE PROMOTION FLOOR, FROM THE OTHER SIDE. Creating a promotion refuses one that would take
  // any fee under a dollar, judged against the prices in force then — which leaves the same
  // floor walkable from here, by republishing a tier low enough that a promotion already on the
  // books reduces it to something Stripe will not accept. The create form claims that cannot
  // happen, so this is where the claim is kept rather than a new rule.
  const running = await activePromotions()
  if (running.length > 0) {
    const clash = validatePricesAgainstPromotions(
      input.map((e) => ({
        tierKey: e.tierKey,
        label: RENTAL_TIERS.find((t) => t.key === e.tierKey)?.label ?? e.tierKey,
        singleCents: e.singleCents,
      })),
      running,
    )
    if (clash) return { error: clash }
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
        // Only a provider who pays rent is governed by the schedule.
        paysRentSql(sql`revenue_model`),
        // AND only one whose fee comes FROM the schedule. The three on `keoni_sets` pay rent
        // but not this rent — Keoni sets each of their sessions from a receipt — so counting
        // them would tell her three people are blocked on prices that do not apply to them.
        // `hasAcceptedRentalTerms` exempts them for the same reason; this is the reporting half
        // of the same rule, and the two have to agree or the page says somebody is blocked who
        // is not.
        sql`rent_basis <> 'keoni_sets'`,
        sql`status = 'active'`,
        sql`booking_enabled`,
        live === null
          ? sql`rental_schedule_version IS NOT NULL`
          : sql`rental_schedule_version IS DISTINCT FROM ${live}`,
      ),
    )

  return row?.n ?? 0
}
