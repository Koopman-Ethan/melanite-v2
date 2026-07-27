import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'

import { requireOnboardingStep } from '../guard'
import { ProgressRail, StepShell } from '../steps'
import { StripeStepForm } from './form'

export const metadata: Metadata = { title: 'Connect Stripe · Melanite' }
export const dynamic = 'force-dynamic'

export default async function StripeStep() {
  const user = await requireOnboardingStep('stripe')

  const [row] = await db
    .select({
      stripeAccountId: providers.stripeAccountId,
      onboardingComplete: providers.stripeOnboardingComplete,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  return (
    <StepShell
      current={4}
      rail={
        <ProgressRail
          current={4}
          heading={
            <>
              Get paid <span className="text-gold">instantly</span>.
            </>
          }
          body="No chasing invoices or waiting for end-of-month payouts. The moment your client pays, Stripe routes your share straight to your bank."
          aside={{
            title: "What you'll need",
            body: 'Stripe will ask for your legal name, date of birth, the last 4 of your SSN for identity verification, and your bank routing and account numbers. Have a recent bank statement handy.',
          }}
        />
      }
    >
      <StripeStepForm
        connected={Boolean(row?.stripeAccountId)}
        payoutsEnabled={Boolean(row?.onboardingComplete)}
      />
    </StepShell>
  )
}
