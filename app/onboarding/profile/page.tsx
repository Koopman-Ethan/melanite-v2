import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'

import { requireOnboardingStep } from '../guard'
import { ProgressRail, StepShell } from '../steps'
import { ProfileForm } from './form'

export const metadata: Metadata = { title: 'Your profile · Melanite' }
export const dynamic = 'force-dynamic'

export default async function ProfileStep() {
  const user = await requireOnboardingStep('profile')

  const [row] = await db
    .select({
      firstName: providers.firstName,
      lastName: providers.lastName,
      phone: providers.phone,
      credentials: providers.credentials,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  return (
    <StepShell
      current={2}
      rail={
        <ProgressRail
          current={2}
          heading={
            <>
              Your name is your <span className="text-gold">credential</span>.
            </>
          }
          body="Clients book treatments knowing exactly who's behind the laser. Your full name and credentials appear on every checkout page — it builds trust and takes the friction out of paying."
        />
      }
    >
      <ProfileForm
        initial={{
          firstName: row?.firstName ?? '',
          lastName: row?.lastName ?? '',
          phone: row?.phone ?? '',
          credentials: row?.credentials ?? '',
        }}
      />
    </StepShell>
  )
}
