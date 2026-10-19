import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { webhookEvents } from '@/lib/db/schema'
import { labelsFor, missingKeys } from '@/lib/end-of-use'
import { getDigestDay, toCollectCents } from '@/lib/db/queries/daily-digest'
import { rentToConfirm } from '@/lib/db/queries/review-queue'
import { settleDueRent } from '@/lib/rental/settle'
import { getLaserHours } from '@/lib/db/queries/availability'
import {
  MELANITE_NOTIFY_EMAIL,
  bookingPaymentSummary,
  denverTimeLabel,
  eveningDigestEmail,
  roomDateLabel,
  sendEmail,
  type DigestEmailRow,
} from '@/lib/email'
import { toMoney } from '@/lib/money'
import { digestDayFor } from '@/lib/validation'
import { appOrigin } from '@/lib/stripe/config'

// The evening digest, from "which day is this" to "the mail went".
//
// Separate from `lib/notify-melanite.ts` on purpose. Everything in that file is best effort and
// swallows its own errors, because each of those messages describes something that has ALREADY
// been committed — a failed send must not look like a failed booking. Here the email IS the
// operation. A silent failure would leave Keoni believing a quiet inbox meant a quiet day, which
// is the exact thing this feature exists to prevent, so this one reports its failures upward.

/** The idempotency key. The Denver date is the whole identity of a run. */
const keyFor = (day: string) => `evening-digest:${day}`

export interface DigestRunResult {
  day: string
  appointments: number
  cancelled: number
  toCollect: string
  /** Rent taken across the day. */
  rent: string
  /** Sessions that used the laser with no rent recorded — a bug, not a quiet day. */
  unbilled: number
  /** The whole backlog waiting on Keoni to confirm an amount, and how old the oldest is. Not a
   *  bug and not today's — see the digest email's `awaitingFigure`. */
  awaitingFigure: number
  awaitingOldestDays: number
  /** What this run collected, and what it could not. The sweep is reported by the digest so a
   *  stalled one shows up in Keoni's inbox the next morning rather than at month end — which,
   *  with four separate things able to drain the queue, is the only way anybody would notice. */
  settledCount: number
  settledCents: number
  settleFailed: number
  delivered: boolean
  /** Set when nothing was sent because this day had already gone out. */
  skipped?: 'already-sent'
  /** Why a send did not land, straight from `sendEmail`. */
  reason?: string
}

/**
 * Build and send one evening's digest.
 *
 * @param day    Denver `YYYY-MM-DD`. Omitted, it resolves to the business day that just ended
 *               — see `digestDayFor`, which is what makes the two DST-driven cron schedules
 *               collapse to one email a night.
 * @param force  Send even if this day was already sent. For the rehearsal button, which would
 *               otherwise block the real run for the rest of the evening.
 */
export async function runEveningDigest(
  { day, force = false }: { day?: string; force?: boolean } = {},
): Promise<DigestRunResult> {
  const hours = await getLaserHours()
  const closeHour = Number(hours.closeTime.split(':')[0])
  const denverDay = day ?? digestDayFor(new Date(), closeHour)
  const eventId = keyFor(denverDay)

  // Claim first, stamp later — the same two-step the Stripe webhook uses. A row that was
  // claimed but never stamped is a previous FAILURE, so the next run retries it rather than
  // reading it as sent. That distinction is the entire reason this is two columns.
  await db
    .insert(webhookEvents)
    .values({
      destination: 'cron',
      eventType: 'evening-digest',
      eventId,
      signatureVerified: true,
    })
    .onConflictDoNothing({ target: webhookEvents.eventId })

  if (!force) {
    const [existing] = await db
      .select({ processedAt: webhookEvents.processedAt })
      .from(webhookEvents)
      .where(eq(webhookEvents.eventId, eventId))
      .limit(1)

    if (existing?.processedAt) {
      return {
        day: denverDay,
        appointments: 0,
        cancelled: 0,
        toCollect: '0.00',
        rent: '0.00',
        unbilled: 0,
        awaitingFigure: 0,
        awaitingOldestDays: 0,
        settledCount: 0,
        settledCents: 0,
        settleFailed: 0,
        delivered: false,
        skipped: 'already-sent',
      }
    }
  }

  // Collect the rent BEFORE reading the day, so the digest reports what it just took rather
  // than describing a day's sessions as unbilled and then billing them a millisecond later.
  //
  // Riding inside the digest is deliberate and is what makes the sweep independent of the Vercel
  // plan tier. Hobby allows two cron jobs and both are already this endpoint (DST), so there is
  // no free slot for a dedicated schedule — and a dedicated schedule is not needed, because
  // every item is idempotent and the predicate has no upper time bound. On Pro the sweep also
  // gets its own hourly route and this call becomes a harmless no-op.
  //
  // OUTSIDE the already-sent guard above on purpose: `force` makes the admin rehearsal button
  // re-send without consuming the day's key, and rent still wants collecting either way.
  const settled = await settleDueRent()

  const data = await getDigestDay(denverDay)

  // THE SAME FUNCTION THE REVIEW QUEUE USES, not a second query shaped like it. Which sessions
  // are waiting on a figure is a six-clause predicate, and a digest that counted them its own
  // way would eventually tell Keoni about a backlog she cannot find, or stay quiet about one
  // sitting in the queue. `waitingDays` comes back as a placeholder from there — it is filled in
  // by `getReviewQueue` — so the age is worked out here from `since`.
  const awaiting = await rentToConfirm()
  const oldestDays =
    awaiting.length === 0
      ? 0
      : Math.max(
          ...awaiting.map((a) =>
            Math.floor((Date.now() - a.since.getTime()) / 86_400_000),
          ),
          0,
        )

  let owedCents = 0
  let rentCents = 0

  const rows: DigestEmailRow[] = data.appointments.map((a) => {
    const cents = toCollectCents(a, data.providerSharePct)
    owedCents += cents
    rentCents += a.rentalCents ?? 0

    return {
      when: denverTimeLabel(a.startTime),
      clientName: a.clientName ?? 'Walk-in',
      serviceName: a.serviceName,
      providerName: a.providerName,
      // The one sentence about what happens next, reused verbatim from the booking alerts so
      // the two emails can never describe the same payment differently.
      paying: bookingPaymentSummary({
        paymentSource: a.paymentSource,
        externalMethod: a.externalMethod,
        price: a.price,
        rentCents: a.rentalCents,
        paidFromPack: a.paidFromPack,
        rentWaived: a.rentWaived,
        rentPastDue: a.rentPastDue,
        rentAwaitingDecision: a.rentAwaitingDecision,
        rentAwaitingFigure: a.rentAwaitingFigure,
      }),
      toCollect: cents > 0 ? toMoney(cents) : null,
      rent: a.rentalCents === null ? null : toMoney(a.rentalCents),
      unbilled: a.unbilled,
      isHouse: a.isHouse,
      status: a.status,
      // A no-show never touched the room, so there is nothing to account for and flagging it as
      // un-closed-out would be the digest inventing a failure.
      closeoutExpected: a.status !== 'no_show',
      closeout: a.closeout,
      // Resolved to labels HERE rather than in the template, so `lib/email.ts` stays free of
      // policy imports and takes strings like every other builder in it.
      missingLabels: a.closeout ? labelsFor(missingKeys(a.closeout.completedItems)) : [],
    }
  })

  const toCollect = toMoney(owedCents)
  const origin = await appOrigin()

  const result = await sendEmail({
    to: MELANITE_NOTIFY_EMAIL,
    ...eveningDigestEmail({
      dayLabel: roomDateLabel(denverDay),
      rows,
      cancelled: data.cancelled,
      toCollectTotal: toCollect,
      toCollectCount: rows.filter((r) => r.toCollect !== null).length,
      rentTotal: toMoney(rentCents),
      awaitingFigure: { count: awaiting.length, oldestDays },
      url: `${origin}/app/admin/revenue`,
    }),
  })

  const summary = {
    day: denverDay,
    appointments: rows.length,
    cancelled: data.cancelled,
    toCollect,
    rent: toMoney(rentCents),
    unbilled: rows.filter((r) => r.unbilled).length,
    awaitingFigure: awaiting.length,
    awaitingOldestDays: oldestDays,
    settledCount: settled.charged,
    settledCents: settled.chargedCents,
    settleFailed: settled.failed,
    delivered: result.delivered,
    ...(result.detail ? { reason: result.detail } : {}),
  }

  // Stamped only on a real delivery. Anything else leaves the claim unprocessed so the second
  // cron schedule, or tomorrow's operator, has something to retry.
  await db
    .update(webhookEvents)
    .set(
      result.delivered
        ? { processedAt: new Date(), payload: summary, error: null }
        : { payload: summary, error: result.detail ?? result.reason ?? 'not delivered' },
    )
    .where(eq(webhookEvents.eventId, eventId))

  return summary
}
