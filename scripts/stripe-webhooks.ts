import '../envConfig'

import { currentEnv } from '../lib/env-guard'

// Which Stripe destinations exist, and whether they take the events this app handles.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/stripe-webhooks.ts
//
// WHY THIS EXISTS
//
// A webhook that is subscribed to the wrong events fails in the worst possible way: Stripe
// accepts the event, reports success, and the app never hears about it. Nothing errors, nothing
// retries, and the only symptom is a thing that quietly did not happen.
//
// It has already happened twice here. `docs/cutover.md` records the live endpoint once pointing
// at the Webflow site and returning 405 to every payment event. And on 7 October 2026
// `checkout.session.completed` was found subscribed to one of v1's DISABLED Xano destinations
// and not to v2's — which would have meant every provider completing Stripe's card page at
// cutover and having nothing saved.
//
// READ ONLY. It lists configuration and changes nothing.

/** Every event type `lib/stripe/handlers.ts` and the webhook route act on. Keep in step with
 *  them: an event handled in code and not subscribed at Stripe is the failure above. */
const HANDLED = [
  'checkout.session.completed',
  'payment_intent.succeeded',
  'charge.refunded',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'account.updated',
  'payout.paid',
  'payout.failed',
]

interface Endpoint {
  id: string
  url: string
  status: string
  enabled_events: string[]
}

async function main() {
  // The READ key on purpose. Listing destinations needs `webhook_read`, and this should never
  // be able to change one.
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set.')
    process.exitCode = 1
    return
  }

  console.log(
    `Stripe destinations for the ${key.includes('_live_') ? 'LIVE' : 'test'} account` +
      ` (MELANITE_ENV=${currentEnv() ?? 'unset'})\n`,
  )

  const res = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=50', {
    headers: { Authorization: `Bearer ${key}` },
  })
  const body = (await res.json()) as { data?: Endpoint[]; error?: { message: string } }

  if (body.error) {
    console.error(`Could not list: ${body.error.message}`)
    console.error(
      '\nIf that is a permissions error, the restricted key needs\n' +
        '"Webhook Endpoints, Event Destinations: Read" — Stripe links the exact page in its reply.',
    )
    process.exitCode = 1
    return
  }

  let problems = 0

  for (const e of body.data ?? []) {
    const live = e.status === 'enabled'
    const all = e.enabled_events.includes('*')
    const missing = all ? [] : HANDLED.filter((h) => !e.enabled_events.includes(h))

    console.log(`${live ? 'ENABLED ' : 'disabled'}  ${e.url}`)
    console.log(`          ${all ? 'all events (*)' : `${e.enabled_events.length} events`}`)

    // Only an ENABLED destination can fail quietly. A disabled one delivers nothing at all,
    // which is loud enough to find — and v1's three are disabled on purpose.
    if (live && missing.length > 0) {
      problems += 1
      console.log(`          MISSING, and the app handles these: ${missing.join(', ')}`)
    } else if (live) {
      console.log('          takes every event the app handles')
    }
    console.log('')
  }

  if (problems > 0) {
    console.error(
      `${problems} enabled destination(s) are missing events the app acts on. Those events will\n` +
        'be accepted by Stripe and delivered nowhere.',
    )
    process.exitCode = 1
    return
  }

  console.log('Every enabled destination takes every event the app handles.')
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
