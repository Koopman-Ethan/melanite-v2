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
      practiceType: providers.practiceType,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  return (
    <StepShell
      current={2}
      practice={row?.practiceType ?? 'laser'}
      rail={
        <ProgressRail
          current={2}
          practice={row?.practiceType ?? 'laser'}
          heading={
            <>
              Your name is your <span className="text-gold">credential</span>.
            </>
          }
          // Was: "Clients book treatments knowing exactly who's behind the laser. Your full
          // name and credentials appear on every checkout page." None of that survives the
          // rental model — a provider's clients never see Melanite, never reach a checkout
          // page, and are not known to it at all. Selling somebody a benefit they will never
          // receive is a worse first impression than saying nothing.
          body="Melanite keeps your name and credentials on file for its own records and for the compliance paperwork behind the suite. Your clients are yours — they never see this app."
        />
      }
    >
      <ProfileForm
        initial={{
          firstName: row?.firstName ?? '',
          lastName: row?.lastName ?? '',
          phone: row?.phone ?? '',
          credentials: row?.credentials ?? '',
          practiceType: row?.practiceType ?? 'laser',
        }}
      />
    </StepShell>
  )
}
