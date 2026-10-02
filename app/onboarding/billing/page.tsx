import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { RENTAL_TIERS } from '@/lib/rental-fees'
import { hasAcceptedRentalTerms, RENTAL_TERMS } from '@/lib/rental-terms'

import { requireOnboardingStep } from '../guard'
import { ProgressRail, StepShell } from '../steps'
import { BillingStepForm } from './form'

export const metadata: Metadata = { title: 'Card on file · Melanite' }
export const dynamic = 'force-dynamic'

export default async function BillingStep() {
  const user = await requireOnboardingStep('billing')

  const [row] = await db
    .select({
      cardBrand: providers.billingCardBrand,
      cardLast4: providers.billingCardLast4,
      cardExpMonth: providers.billingCardExpMonth,
      cardExpYear: providers.billingCardExpYear,
      rentalTermsVersion: providers.rentalTermsVersion,
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
              Your clients, <span className="text-gold">your business</span>.
            </>
          }
          body="You charge your own clients however you like, and pay Melanite a flat fee for each session you use the laser. Nothing you bill passes through this app."
          aside={{
            title: "What you'll need",
            body: 'A debit or credit card. Stripe takes the details directly — Melanite never sees them. No bank account, no SSN, and no identity check: this card is only ever charged by Melanite, never paid into.',
          }}
        />
      }
    >
      <BillingStepForm
        card={
          row?.cardLast4
            ? {
                brand: row.cardBrand,
                last4: row.cardLast4,
                expMonth: row.cardExpMonth,
                expYear: row.cardExpYear,
              }
            : null
        }
        termsAccepted={hasAcceptedRentalTerms(row)}
        terms={RENTAL_TERMS.map((t) => ({ key: t.key, text: t.text }))}
        // The fee schedule is part of what is being agreed to, so it is on the screen where the
        // agreeing happens rather than a link somebody could reasonably not follow.
        tiers={RENTAL_TIERS.map((t) => ({
          key: t.key,
          label: t.label,
          singleCents: t.fee.singleCents,
          packs: t.fee.packs.map((p) => ({ sessions: p.sessions, cents: p.cents })),
        }))}
      />
    </StepShell>
  )
}
