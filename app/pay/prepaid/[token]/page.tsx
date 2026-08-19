import type { Metadata } from 'next'

import { getPrepaidCheckout } from '@/lib/db/queries/checkout'

import { PrepaidCheckoutForm } from './checkout'

export const metadata: Metadata = {
  title: 'Add a prepaid balance · Melanite',
  robots: { index: false, follow: false },
}
export const dynamic = 'force-dynamic'

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto w-full max-w-lg rounded-card border border-line bg-surface p-8 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-ink-muted">{body}</p>
    </div>
  )
}

export default async function PayPrepaidPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const checkout = await getPrepaidCheckout(token)

  // All five states kept distinct, as every other link page here does. "Wrong link", "too
  // late", "already done" and "cannot be paid" need completely different actions from whoever
  // is reading, and collapsing them into one error means everybody rings the provider.
  if (!checkout) {
    return (
      <Message
        title="Payment link not found"
        body="Check the link you were sent, or ask the provider to send a new one."
      />
    )
  }

  if (checkout.state === 'paid') {
    return (
      <Message
        title="Already paid"
        body={`This balance is already on ${checkout.clientName ?? 'the client'}'s account. Book with the provider as usual and it will be applied.`}
      />
    )
  }

  if (checkout.state === 'expired') {
    return (
      <Message
        title="This link has expired"
        body="Prepaid links are valid for a limited time. Ask the provider for a new one."
      />
    )
  }

  if (checkout.state === 'cancelled') {
    return (
      <Message
        title="This link was cancelled"
        body="The provider cancelled this link, usually because a newer one replaced it. Contact them if that seems wrong."
      />
    )
  }

  if (checkout.state === 'unpayable') {
    return (
      <Message
        title="This can’t be paid right now"
        body="The provider isn’t set up to take payment yet. Contact them directly."
      />
    )
  }

  return (
    <PrepaidCheckoutForm
      token={token}
      summary={{
        amount: checkout.amount,
        providerName: checkout.providerName,
        providerCredentials: checkout.providerCredentials,
        clientName: checkout.clientName,
        purchaserName: checkout.purchaserName,
        purchaserEmail: checkout.purchaserEmail,
      }}
    />
  )
}
