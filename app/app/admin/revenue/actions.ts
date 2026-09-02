'use server'

import { requireAdmin } from '@/lib/auth/dal'
import { runEveningDigest } from '@/lib/digest/run'
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

    return {
      success: `Sent ${result.day}: ${result.appointments} ${
        result.appointments === 1 ? 'appointment' : 'appointments'
      }, $${result.toCollect} to collect. Redirected — check the address in EMAIL_REDIRECT_TO.`,
    }
  } catch (error) {
    console.error('[digest] the rehearsal send failed', error)
    return { error: 'The digest could not be built. The server log has the detail.' }
  }
}
