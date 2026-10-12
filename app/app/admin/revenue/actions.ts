'use server'

import { requireAdmin } from '@/lib/auth/dal'
import { runEveningDigest } from '@/lib/digest/run'
import { toMoney } from '@/lib/money'
import { settleDueRent } from '@/lib/rental/settle'
import { isProduction } from '@/lib/env-guard'

export interface DigestState {
  error?: string
  success?: string
}

/**
 * Sends the evening digest on demand, so it can be seen outside production.
 *
 * Vercel Cron only ever invokes the production deployment, which means the scheduled path
 * cannot be rehearsed anywhere — the first real run would otherwise be the one that lands in
 * Keoni's inbox. This button is that rehearsal.
 *
 * `isProduction()` rather than `requireEnv(['dev'], …)`, and the difference matters: `requireEnv`
 * refuses an ABSENT `MELANITE_ENV`, and the variable is deliberately absent on Vercel Preview.
 * Gating this with it would disable the button on appdev, which is exactly where it is wanted.
 *
 * Checked here and not only at render. A server action is reachable whatever the page drew, so
 * hiding the button is presentation; this is the control.
 */
export async function sendDigestPreview(
  _prev: DigestState,
  _formData: FormData,
): Promise<DigestState> {
  await requireAdmin()

  if (isProduction()) {
    return { error: 'Not available in production — the nightly cron sends the real one.' }
  }

  try {
    // Forced, because a rehearsal must not consume the day's idempotency key and leave the
    // real evening run thinking it had already gone out.
    const result = await runEveningDigest({ force: true })

    if (!result.delivered) {
      return {
        error:
          result.reason ??
          'Nothing was sent. Outside production this needs EMAIL_REDIRECT_TO set, and RESEND_API_KEY to actually deliver — otherwise it is printed to the server console.',
      }
    }

    // Leads with rent, because that is what an ordinary day now consists of. The other two are
    // mentioned only when they are not zero: "$0.00 to collect" every evening is how a line
    // stops being read, and the unbilled count needs to stand out on the one day it is not
    // zero.
    const notes = [
      `$${result.rent} rent`,
      ...(Number(result.toCollect) > 0 ? [`$${result.toCollect} to collect`] : []),
      ...(result.unbilled > 0
        ? [`${result.unbilled} NOT BILLED`]
        : []),
    ]

    return {
      success: `Sent ${result.day}: ${result.appointments} ${
        result.appointments === 1 ? 'appointment' : 'appointments'
      }, ${notes.join(', ')}. Redirected — check the address in EMAIL_REDIRECT_TO.`,
    }
  } catch (error) {
    console.error('[digest] the rehearsal send failed', error)
    return { error: 'The digest could not be built. The server log has the detail.' }
  }
}

/** Collects every rental fee that is due now, rather than waiting for tonight.
 *
 *  THE BUTTON EXISTS BECAUSE CRON IS NOT TRUSTWORTHY ENOUGH TO BE THE ONLY WAY. Four things
 *  drain the queue — the nightly digest, the settle-rent route, an opportunistic trigger on app
 *  page loads, and this. None of them is load-bearing, because every item is idempotent and
 *  stays eligible until it is charged, waived or decided.
 *
 *  Unlike `sendDigestPreview` this is NOT refused in production. It takes money that is already
 *  owed, twelve hours after the session, on exactly the terms the provider accepted — so there
 *  is nothing about doing it early that needs protecting against. It is the lever Keoni pulls
 *  when something is obviously stuck.
 */
export async function settleRentNow(
  _prev: DigestState,
  _formData: FormData,
): Promise<DigestState> {
  await requireAdmin()

  try {
    const r = await settleDueRent()

    // "Nothing charged" is not "nothing owed". A card that declined earlier is inside its
    // back-off and will not be tried again for twenty hours — saying everything was settled
    // would be telling Keoni the opposite of the truth about money she is owed.
    if (r.charged === 0 && r.failed === 0) {
      if (r.deferred > 0) {
        return {
          error:
            `Nothing could be taken. ${r.deferred} session${r.deferred === 1 ? '' : 's'} ` +
            'failed earlier and will not be retried for a few hours — they are in the queue.',
        }
      }
      return { success: 'Nothing was due. Every session past its grace period is settled.' }
    }

    const parts = [
      `${r.charged} session${r.charged === 1 ? '' : 's'} charged, $${toMoney(r.chargedCents)}`,
      ...(r.failed > 0 ? [`${r.failed} FAILED — see the queue`] : []),
      // -1 is the sentinel for "the batch was full", i.e. there is more behind this run.
      ...(r.remaining !== 0 ? ['more still due — run it again'] : []),
    ]

    return { success: parts.join(' · ') }
  } catch (error) {
    console.error('[settle] the manual sweep failed', error)
    return { error: 'The sweep could not run. The server log has the detail.' }
  }
}
