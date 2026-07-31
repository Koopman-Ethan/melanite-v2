import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'

import { requireOnboardingStep } from '../guard'
import { ProgressRail, StepShell } from '../steps'
import { LicenseForm } from './form'

export const metadata: Metadata = { title: 'License & compliance · Melanite' }
export const dynamic = 'force-dynamic'

export default async function LicenseStep() {
  const user = await requireOnboardingStep('license')

  const [row] = await db
    .select({
      licenseNumber: providers.licenseNumber,
      licenseState: providers.licenseState,
      licenseExpiry: providers.licenseExpiry,
      malpracticeInsurance: providers.malpracticeInsurance,
      practiceType: providers.practiceType,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  // The rail counts only the steps this provider walks. By now they have chosen, so a room
  // renter sees "3 of 4" and no Connect step waiting for them.
  const practice = row?.practiceType ?? 'laser'

  return (
    <StepShell
      current={3}
      practice={practice}
      rail={
        <ProgressRail
          current={3}
          practice={practice}
          heading={
            <>
              Why we ask for <span className="text-gold">your license</span>.
            </>
          }
          body="Melanite operates under strict compliance standards. Your license and insurance details are kept on file for platform records and are never shared with clients."
          aside={{
            title: 'Confidentiality',
            body: 'License numbers, expiry dates and insurance information are visible only to Melanite administrators. They are never displayed on client checkout pages or shared with third parties.',
          }}
        />
      }
    >
      <LicenseForm
        initial={{
          licenseNumber: row?.licenseNumber ?? '',
          licenseState: row?.licenseState ?? '',
          licenseExpiry: row?.licenseExpiry ?? '',
          malpracticeInsurance: row?.malpracticeInsurance ?? '',
        }}
      />
    </StepShell>
  )
}
