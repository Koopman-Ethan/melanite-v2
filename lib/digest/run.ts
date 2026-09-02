import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { webhookEvents } from '@/lib/db/schema'
import { getDigestDay, toCollectCents } from '@/lib/db/queries/daily-digest'
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
import { toCents, toMoney } from '@/lib/money'
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
        delivered: false,
        skipped: 'already-sent',
      }
    }
  }

  const data = await getDigestDay(denverDay)

  let grossCents = 0
  let owedCents = 0

  const rows: DigestEmailRow[] = data.appointments.map((a) => {
    const cents = toCollectCents(a, data.providerSharePct)
    grossCents += toCents(a.price)
    owedCents += cents

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
      }),
      toCollect: cents > 0 ? toMoney(cents) : null,
      isHouse: a.isHouse,
      status: a.status,
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
      grossTotal: toMoney(grossCents),
      toCollectTotal: toCollect,
      toCollectCount: rows.filter((r) => r.toCollect !== null).length,
      url: `${origin}/app/admin/revenue`,
    }),
  })

  const summary = {
    day: denverDay,
    appointments: rows.length,
    cancelled: data.cancelled,
    toCollect,
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
