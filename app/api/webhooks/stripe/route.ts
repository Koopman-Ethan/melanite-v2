import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { webhookEvents } from '@/lib/db/schema'
import { dispatch, linkSubscriptionCustomer } from '@/lib/stripe/handlers'
import { verifyStripeSignature } from '@/lib/stripe/signature'
import type { StripeCheckoutSessionObject, StripeEvent } from '@/lib/stripe/types'

// ONE Stripe webhook endpoint.
//
// v1 has four (/platform, /connect, /package, /room), each re-implementing signature
// verification and logging, and each drifting from the others — which is how the platform
// endpoint ended up handling refunds for training only, leaving booking refunds unrecorded
// forever. One endpoint dispatching on event type removes the category.
//
// Order of operations, taken from v1 because it is right:
//   1. read the RAW body — parsing and re-serialising changes the bytes and breaks the HMAC
//   2. LOG the attempt, including whether verification passed
//   3. only then reject an invalid signature
//
// Logging before rejecting is deliberate: a forged or misconfigured call is exactly the thing
// you want a record of, and a handler that returns 403 without leaving a trace tells you
// nothing afterwards.

export const dynamic = 'force-dynamic'
/** Node runtime: signature verification uses node:crypto. */
export const runtime = 'nodejs'

function secretFor(): string | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  return secret && secret.length > 0 ? secret : null
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature')
  const secret = secretFor()

  if (!secret) {
    // Refuse rather than accept unverified events. Without a secret there is no way to tell
    // Stripe from anyone who found the URL, and this endpoint writes money.
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — refusing')
    return Response.json({ error: 'Webhook not configured' }, { status: 500 })
  }

  const result = verifyStripeSignature(rawBody, signature, secret)

  // Parsed only for logging identifiers; nothing is trusted before verification passes.
  let event: StripeEvent | null = null
  try {
    event = JSON.parse(rawBody) as StripeEvent
  } catch {
    event = null
  }

  const [logged] = await db
    .insert(webhookEvents)
    .values({
      destination: 'stripe',
      eventType: event?.type ?? null,
      eventId: event?.id ?? null,
      payload: event ? (event as unknown as Record<string, unknown>) : { raw: rawBody.slice(0, 2000) },
      signatureVerified: result.valid,
    })
    .returning({ id: webhookEvents.id })
    // A duplicate event id hits the unique index. That is Stripe retrying, which is normal,
    // so it must not 500 — the dedupe check below turns it into a no-op.
    .onConflictDoNothing({ target: webhookEvents.eventId })

  if (!result.valid) {
    console.warn(`[stripe-webhook] signature rejected: ${result.reason}`)
    return Response.json({ error: 'Signature verification failed' }, { status: 400 })
  }

  if (!event) {
    return Response.json({ error: 'Malformed payload' }, { status: 400 })
  }

  // If the insert conflicted, this event has been seen. Stripe retries until it gets a 2xx,
  // including after a success its side never recorded, so this has to be cheap and certain.
  if (!logged) {
    const [prior] = await db
      .select({ processedAt: webhookEvents.processedAt })
      .from(webhookEvents)
      .where(eq(webhookEvents.eventId, event.id))
      .limit(1)

    if (prior?.processedAt) {
      return Response.json({ received: true, duplicate: true })
    }
  }

  try {
    // checkout.session.completed only links the customer; the invoice event carries the money.
    // Splitting them this way means a checkout that completes but whose invoice fails does not
    // silently grant access.
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as unknown as StripeCheckoutSessionObject
      const providerId = session.metadata?.provider_id
      if (session.mode === 'subscription' && providerId) {
        await linkSubscriptionCustomer(providerId, session.customer, session.subscription)
      }
    } else {
      const outcome = await dispatch(event)
      if (!outcome.handled) {
        // Not an error — an event we do not act on. Logged so "subscribed but unhandled"
        // is visible rather than silent, which is exactly how v1 lost every
        // customer.subscription.updated.
        console.log(`[stripe-webhook] ${event.type} not handled: ${outcome.detail}`)
      }
    }

    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.eventId, event.id))

    return Response.json({ received: true })
  } catch (err) {
    // Record the failure and return 500 so Stripe retries. Swallowing it would mean the event
    // is gone forever and the ledger is quietly wrong.
    console.error(`[stripe-webhook] handler failed for ${event.type}`, err)

    await db
      .update(webhookEvents)
      .set({ error: err instanceof Error ? err.message : String(err) })
      .where(eq(webhookEvents.eventId, event.id))

    return Response.json({ error: 'Handler failed' }, { status: 500 })
  }
}
