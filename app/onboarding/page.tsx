import { redirect } from 'next/navigation'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { isOnboarding, nextStepSlug } from '@/lib/onboarding'

import { eq } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

/** Resumes setup wherever it was left. The link in the invite email lands here after
 *  activation, and so does anyone who closed the tab halfway through. */
export default async function OnboardingIndex() {
  const user = await requireProvider()
  if (!isOnboarding(user)) redirect('/app/dashboard')

  const [row] = await db
    .select({ step: providers.onboardingStep })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  redirect(`/onboarding/${nextStepSlug(row?.step ?? 1)}`)
}
