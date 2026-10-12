import { checkCronBearer } from '@/lib/cron/auth'
import { settleDueRent } from '@/lib/rental/settle'

// Taking rent on sessions that have happened, triggered by Vercel Cron.
//
// NOT IN `vercel.json` YET, and that is deliberate rather than an omission.
//
// Hobby allows two cron jobs and both are spent on the evening digest (fired twice, for DST), so
// there is no free slot. The sweep therefore rides inside the digest, which is one of four
// things that drain it — along with this route, the admin button on /app/admin/revenue, and an
// opportunistic trigger on app page loads. Add an entry here the day the project moves to Pro
// and the only thing that changes is latency: hourly instead of nightly.
//
// That is the whole design, and it is why cron reliability is not a worry. Eligibility is a
// predicate over database state and `now()` (see `lib/rental/settle.ts`), so a run that is late,
// doubled, skipped or killed half way through changes WHEN money lands and never WHETHER it
// does. Charging is idempotent at the booking, not at the run, so there is intentionally no
// once-per-day key here: the unit of work is a session.
//
// SAFE TO CALL BY HAND, which is how it gets tested — Vercel Cron does not fire locally:
//
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3113/api/cron/settle-rent
//
// Unlike the digest this route is NOT production-only. The digest is gated by the fact that cron
// only invokes production, because an email to Keoni from a preview would be a real email. This
// moves money, and the protection against moving the wrong money is the Stripe key the
// environment carries, not where the request came from.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request) {
  const auth = checkCronBearer(request.headers.get('authorization'), process.env.CRON_SECRET)

  if (!auth.ok) {
    if (auth.reason === 'not-configured') {
      console.error('[cron] CRON_SECRET is not set — refusing to settle rent')
      return Response.json({ error: 'not configured' }, { status: 500 })
    }

    // Logged so a probe of the URL leaves a trace. Never the token.
    console.warn(`[cron] rejected a settle-rent request (${auth.reason})`)
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await settleDueRent()

    // 200 even when charges failed, which is the opposite of the digest's choice and right for
    // the opposite reason. A declined card is an expected outcome here, recorded on the booking
    // and surfaced in Keoni's queue — not a failure of this request. Returning 502 would make
    // Vercel's cron log red every time a provider's card expired, and the one signal worth
    // watching would be lost in it.
    return Response.json(result, { status: 200 })
  } catch (error) {
    console.error('[cron] settling rent failed', error)
    return Response.json({ error: 'settle failed' }, { status: 500 })
  }
}
