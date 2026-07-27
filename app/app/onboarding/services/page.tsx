import type { Metadata } from 'next'
import { asc, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { services } from '@/lib/db/schema'

import { requireOnboardingStep } from '../guard'
import { ProgressRail, StepShell } from '../steps'
import { ServicesForm } from './form'

export const metadata: Metadata = { title: 'Choose your services · Melanite' }
export const dynamic = 'force-dynamic'

export default async function ServicesStep() {
  await requireOnboardingStep('services')

  const catalog = await db
    .select({
      id: services.id,
      name: services.name,
      description: services.description,
      suggestedDurationMins: services.suggestedDurationMins,
      minDurationMins: services.minDurationMins,
      maxDurationMins: services.maxDurationMins,
    })
    .from(services)
    .where(eq(services.active, true))
    .orderBy(asc(services.name))

  return (
    <StepShell
      current={6}
      rail={
        <ProgressRail
          current={6}
          heading={
            <>
              Your menu, <span className="text-gold">your prices</span>.
            </>
          }
          body="Melanite suggests durations based on the Boise market — but you decide what your work is worth. Every service you switch on becomes bookable the moment Melanite clears your documents."
          aside={{
            title: 'Pricing tip',
            body: 'Melanite takes 50% of the service price, but 100% of tips are yours. Most providers price slightly above the midpoint to account for the split.',
          }}
        />
      }
    >
      <ServicesForm catalog={catalog} />
    </StepShell>
  )
}
