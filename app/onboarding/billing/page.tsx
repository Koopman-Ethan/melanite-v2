import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { hasAcceptedRentalTerms, RENTAL_TERMS } from '@/lib/rental-terms'
import { getLiveSchedule } from '@/lib/rental/schedule'

import { requireOnboardingStep } from '../guard'
import { ProgressRail, StepShell } from '../steps'
import { BillingStepForm } from './form'

export const metadata: Metadata = { title: 'Card on file · Melanite' }
export const dynamic = 'force-dynamic'

export default async function BillingStep() {
  const user = await requireOnboardingStep('billing')

  const schedule = await getLiveSchedule()

  const [row] = await db
    .select({
      cardBrand: providers.billingCardBrand,
      cardLast4: providers.billingCardLast4,
      cardExpMonth: providers.billingCardExpMonth,
      cardExpYear: providers.billingCardExpYear,
      rentalTermsVersion: providers.rentalTermsVersion,
      rentalScheduleVersion: providers.rentalScheduleVersion,
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
        termsAccepted={hasAcceptedRentalTerms(row, schedule.version)}
        terms={RENTAL_TERMS.map((t) => ({ key: t.key, text: t.text }))}
        // The fee schedule is part of what is being agreed to, so it is on the screen where the
        // agreeing happens rather than a link somebody could reasonably not follow.
        // The schedule actually in force, not the one the code shipped with — a provider is
        // accepting what they will be charged.
        tiers={schedule.entries.map((e) => ({
          key: e.tierKey,
          label: e.label,
          singleCents: e.singleCents,
          suggestedLowCents: e.suggestedLowCents,
          suggestedHighCents: e.suggestedHighCents,
        }))}
      />
    </StepShell>
  )
}
