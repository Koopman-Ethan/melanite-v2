import type { Metadata } from 'next'

import { getCheckoutSettings, getPackageCheckout } from '@/lib/db/queries/checkout'

import { PackageCheckout } from './checkout'

export const metadata: Metadata = {
  title: 'Complete your purchase · Melanite',
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

export default async function PayPackagePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const [checkout, settings] = await Promise.all([
    getPackageCheckout(token),
    getCheckoutSettings(),
  ])

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
        title="Already purchased"
        body="This package has been paid for. Your sessions are on your account — book them with your provider as usual."
      />
    )
  }

  if (checkout.state === 'expired') {
    return (
      <Message
        title="This link has expired"
        body="Package links are valid for a limited time. Ask your provider for a new one."
      />
    )
  }

  if (checkout.state === 'cancelled') {
    return (
      <Message
        title="This link was cancelled"
        body="Your provider cancelled this package link. Contact them if that seems wrong."
      />
    )
  }

  if (checkout.state === 'unpayable') {
    return (
      <Message
        title="This can’t be paid right now"
        body="Your provider isn’t set up to take payment yet. Contact them directly."
      />
    )
  }

  return (
    <PackageCheckout
      token={token}
      pkg={{
        templateName: checkout.templateName,
        providerName: checkout.providerName,
        providerCredentials: checkout.providerCredentials,
        clientName: checkout.clientName,
        clientEmail: checkout.clientEmail,
        price: checkout.price,
        expiresAfterDays: checkout.expiresAfterDays,
        items: checkout.items,
      }}
      cherryUrl={settings.cherryApplyUrl}
    />
  )
}
