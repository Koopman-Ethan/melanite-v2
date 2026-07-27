// Professional licence state.
//
// The licence is one of the three booking gates, and it is the only one that fails on a date
// rather than on an action. Nobody does anything wrong and one morning booking stops working —
// which is why "expired" is not enough on its own. It needs a window beforehand, and it needs
// somebody other than the provider to be able to see that window coming.

/** How far ahead a renewal starts being mentioned.
 *
 *  Sixty days because a state board renewal is not a same-day errand: there is paperwork, often
 *  continuing-education hours, and a processing wait. Thirty days would be a deadline, not a
 *  warning. */
export const LICENSE_WARNING_DAYS = 60

export type LicenseState = 'missing' | 'expired' | 'expiring' | 'ok'

export interface LicenseStatus {
  state: LicenseState
  /** Days until expiry. Negative once past, null when there is no date on file. */
  daysLeft: number | null
}

/** Today in America/Denver as YYYY-MM-DD.
 *
 *  A calendar date, never a timestamp. A licence valid "through the 31st" must not expire at
 *  6pm on the 30th because the server happens to run in UTC. */
export function denverToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now)
}

/** Whole days between two YYYY-MM-DD dates.
 *
 *  Both are parsed as UTC midnight, so the subtraction is exact — no DST hour creeping in to
 *  make a 60-day gap read as 59.958 and round the wrong way. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

export function licenseStatus(
  expiry: string | null | undefined,
  now: Date = new Date(),
): LicenseStatus {
  // Deliberately its own state rather than folded into 'ok'. `isLicenseExpired` treats a
  // missing date as "not expired", which is defensible for a gate that must not lock out
  // imported rows — but it is not something to repeat here, where the whole point is to make
  // the situation visible.
  if (!expiry) return { state: 'missing', daysLeft: null }

  const daysLeft = daysBetween(denverToday(now), expiry)

  if (daysLeft < 0) return { state: 'expired', daysLeft }
  if (daysLeft <= LICENSE_WARNING_DAYS) return { state: 'expiring', daysLeft }
  return { state: 'ok', daysLeft }
}

/** Wording for the provider, who can act on it. */
export function licenseMessage(status: LicenseStatus, expiry: string | null): string | null {
  switch (status.state) {
    case 'expired':
      return `Your licence expired on ${expiry}, which is blocking booking. Update the date below once you’ve renewed.`
    case 'expiring':
      return status.daysLeft === 0
        ? `Your licence expires today. Booking stops tomorrow unless it’s renewed.`
        : `Your licence expires in ${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'}, on ${expiry}. Renew before then — booking stops the day after it lapses.`
    case 'missing':
      return 'There’s no licence expiry date on your account. Add it below so Melanite can keep your booking access current.'
    default:
      return null
  }
}

/** Sort key for an admin list: the most urgent first, and a missing date counts as urgent
 *  rather than sorting to the bottom where nobody looks at it. */
export function licenseUrgency(status: LicenseStatus): number {
  if (status.state === 'missing') return -100000
  return status.daysLeft ?? 0
}
