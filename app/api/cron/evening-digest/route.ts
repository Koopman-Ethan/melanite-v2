import { checkCronBearer } from '@/lib/cron/auth'
import { runEveningDigest } from '@/lib/digest/run'
import { DATE_ONLY } from '@/lib/validation'

// The evening digest, triggered by Vercel Cron.
//
// Scheduled TWICE in `vercel.json`, at 02:00 and 03:00 UTC, because cron has no notion of DST
// and 8pm Denver is one or the other depending on the season. Both fire year-round; the run
// works out which Denver business day just ended, and the idempotency key makes the second one
// a no-op. See `digestDayFor` in `lib/validation.ts` for why that beats gating on the hour.
//
// Vercel Cron only ever invokes the PRODUCTION deployment, which is also the only place
// `MELANITE_ENV` is set to `prod` — so this route cannot mail Keoni from anywhere else. The
// rehearsal path outside production is the button on /app/admin/revenue.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request) {
  const auth = checkCronBearer(request.headers.get('authorization'), process.env.CRON_SECRET)

  if (!auth.ok) {
    if (auth.reason === 'not-configured') {
      console.error('[cron] CRON_SECRET is not set — refusing to run the evening digest')
      return Response.json({ error: 'not configured' }, { status: 500 })
    }

    // Logged so a probe of the URL leaves a trace. Never the token.
    console.warn(`[cron] rejected an evening-digest request (${auth.reason})`)
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const date = url.searchParams.get('date')

  if (date && !DATE_ONLY.test(date)) {
    return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
  }

  try {
    const result = await runEveningDigest({
      day: date ?? undefined,
      force: url.searchParams.get('force') === '1',
    })

    // A failed send is a non-2xx, deliberately. Everywhere else in this codebase a failed email
    // is best-effort and swallowed, because the operation it describes already succeeded. Here
    // the email is the whole operation, and a silent failure would read as a quiet evening.
    const status = result.delivered || result.skipped ? 200 : 502
    return Response.json(result, { status })
  } catch (error) {
    console.error('[cron] the evening digest failed', error)
    return Response.json({ error: 'digest failed' }, { status: 500 })
  }
}
