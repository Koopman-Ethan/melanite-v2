import type { Metadata } from 'next'

import { getBookingCheckout, getCheckoutSettings } from '@/lib/db/queries/checkout'

import { BookingCheckout } from './checkout'

export const metadata: Metadata = {
  title: 'Complete your payment · Melanite',
  // A payment link is not something search engines should hold on to.
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

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const [checkout, settings] = await Promise.all([
    getBookingCheckout(token),
    getCheckoutSettings(),
  ])

  // Every dead-end says which one it is. v1 returned LINK_NOT_FOUND, LINK_EXPIRED and
  // LINK_CANCELLED as error codes and left the page to interpret them; a client who cannot
  // tell "wrong link" from "too late" just calls the provider either way.
  if (!checkout) {
    return (
      <Message
        title="Payment link not found"
        body="Check the link you were sent, or ask your provider to send a new one."
      />
    )
  }

  if (checkout.state === 'paid') {
    return (
      <Message
        title="Already paid"
        body={`This appointment was paid${
          checkout.paidAt
            ? ` on ${checkout.paidAt.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                timeZone: 'America/Denver',
              })}`
            : ''
        }. Nothing further is needed.`}
      />
    )
  }

  if (checkout.state === 'expired') {
    return (
      <Message
        title="This link has expired"
        body="Payment links are valid for a limited time. Ask your provider for a new one."
      />
    )
  }

  if (checkout.state === 'cancelled') {
    return (
      <Message
        title="This link was cancelled"
        body="Your provider cancelled this payment link. Contact them if that seems wrong."
      />
    )
  }

  if (checkout.state === 'unpayable') {
    return (
      <Message
        title="This can’t be paid right now"
        body="The appointment may have been cancelled or already taken place. Contact your provider."
      />
    )
  }

  return (
    <BookingCheckout
      token={token}
      booking={{
        clientName: checkout.clientName,
        clientEmail: checkout.clientEmail,
        serviceName: checkout.serviceName,
        treatmentArea: checkout.treatmentArea,
        providerName: checkout.providerName,
        providerCredentials: checkout.providerCredentials,
        startTime: checkout.startTime.toISOString(),
        durationMins: checkout.durationMins,
        price: checkout.price,
        originalPrice: checkout.originalPrice,
        discountType: checkout.discountType,
        discountValue: checkout.discountValue,
      }}
      policy={{
        lateCancellationHours: settings.lateCancellationHours,
        cancellationFeeAmount: settings.cancellationFeeAmount,
        noShowFeePct: settings.noShowFeePctOfPrice,
      }}
    />
  )
}
