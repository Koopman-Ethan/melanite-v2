// When a lease's rent is taken, as dates. Pure: no database, no Stripe, no clock it does not
// take as an argument.
//
// Keoni's rule (4 November 2026): a part-month is prorated, and from then on rent comes out on the
// 1st. Stripe does the proration itself given two instants — when the period began and when the
// cycle is anchored — so all this has to get right is which dates those are.
//
// Every date here is a Denver calendar date (`YYYY-MM-DD`). Turning one into an instant is the
// caller's job, with `denverInstant`, so "the 1st" means midnight in the business's timezone and
// not 6pm the evening before.

export const NOTICE_DAYS = 30

/** How the subscription should be set up for a lease starting on `startsOn`, decided on `today`. */
export type LeaseSchedule =
  /** Starts now or earlier this month. Stripe charges the part-month at once, from `periodStart`
   *  (a backdate when it is before today), and anchors the cycle on `anchor`, the next 1st. */
  | { kind: 'prorate'; periodStart: string; backdated: boolean; anchor: string }
  /** Starts on a later 1st. Nothing is charged until then; the first full month is taken on
   *  `firstCharge` and the cycle runs from there. */
  | { kind: 'future'; firstCharge: string }

export function firstOfNextMonth(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
}

export function addDaysYmd(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function addMonthsYmd(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  // Clamped to the last day of the target month, so 31 August + 6 months is 28 February rather
  // than rolling into March.
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10)
}

/**
 * The billing shape for a lease, or the reason it cannot be set up that way.
 *
 * Two shapes, and two refusals:
 *  - a start later this month cannot be billed yet without charging for days not yet occupied,
 *    and a subscription cannot be both deferred and anchored to a different day. Set the lease
 *    up on move-in day instead, when it is simply "now".
 *  - a start in an earlier month would backdate across a 1st, charging months nobody agreed to
 *    in this app. Those months are settled outside it.
 */
export function leaseSchedule(startsOn: string, today: string): LeaseSchedule | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) return { error: 'Choose a start date.' }

  if (startsOn > today) {
    if (startsOn.endsWith('-01')) return { kind: 'future', firstCharge: startsOn }
    return {
      error:
        'A lease starting later has to start on the 1st. For a mid-month move-in, set the lease up on the day they move in — the first month is prorated from then.',
    }
  }

  if (startsOn.slice(0, 7) !== today.slice(0, 7)) {
    return {
      error:
        'A lease can only be backdated within this month. Earlier months were settled outside the app — start it today or on the next 1st.',
    }
  }

  return {
    kind: 'prorate',
    periodStart: startsOn,
    backdated: startsOn < today,
    anchor: firstOfNextMonth(today),
  }
}

/** The day a lease ends when notice is given on `noticeOn`. */
export function endsAfterNotice(noticeOn: string): string {
  return addDaysYmd(noticeOn, NOTICE_DAYS)
}

/**
 * Did the tenant complete the term? Keoni refunds the deposit after a completed term with 30
 * days' notice, and keeps it if they leave early — this is her rule as a SUGGESTION. The decision
 * is still hers each time; a tenant who left a week early for a good reason is her call.
 */
export function completedTerm(lease: {
  startsOn: string
  termMonths: number
  endsOn: string | null
  noticeGivenOn: string | null
}): boolean {
  if (!lease.endsOn || !lease.noticeGivenOn) return false
  return lease.endsOn >= addMonthsYmd(lease.startsOn, lease.termMonths)
}
