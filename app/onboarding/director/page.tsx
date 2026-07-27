import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'

import { requireOnboardingStep } from '../guard'
import { ProgressRail, StepShell } from '../steps'
import { DirectorForm } from './form'

export const metadata: Metadata = { title: 'Medical director · Melanite' }
export const dynamic = 'force-dynamic'

export default async function DirectorStep() {
  const user = await requireOnboardingStep('director')

  const [row] = await db
    .select({
      type: providers.medicalDirectorType,
      status: providers.medicalDirectorStatus,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  return (
    <StepShell
      current={5}
      rail={
        <ProgressRail
          current={5}
          heading={
            <>
              <span className="text-gold">Compliant</span> from day one.
            </>
          }
          body="Every laser provider needs a medical director overseeing treatments. Choose Melanite's for a simple monthly fee, or bring your own physician."
          aside={{
            title: 'Why this matters',
            body: "Medical oversight keeps you compliant with state regulations for laser procedures. Melanite's director plan includes protocol review and is required to accept bookings on the platform.",
          }}
        />
      }
    >
      <DirectorForm
        initialChoice={row?.type ?? null}
        subscriptionActive={row?.status === 'active'}
      />
    </StepShell>
  )
}
