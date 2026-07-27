import 'server-only'

import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { canOpenStep, isOnboarding, nextStepSlug, type OnboardingSlug } from '@/lib/onboarding'

/**
 * The guard for a single setup step.
 *
 * Deliberately per-step rather than in the layout: the final screen is reached AFTER status
 * flips to active, so a layout-level "already finished, go away" check would bounce a provider
 * off their own completion page.
 *
 * Two rules:
 *  - Finished accounts belong in the app, not back in setup. Letting an active provider re-run
 *    step 6 would wipe and rewrite their whole service menu.
 *  - You cannot skip ahead. Going back is always allowed — revisiting a finished step to fix a
 *    typo is not an attack, and v1 enforced the same `<= onboarding_step + 1` rule server-side.
 */
export async function requireOnboardingStep(slug: OnboardingSlug) {
  const user = await requireProvider()

  if (!isOnboarding(user)) redirect('/app/dashboard')

  const [row] = await db
    .select({ step: providers.onboardingStep })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  const step = row?.step ?? 1
  if (!canOpenStep(slug, step)) redirect(`/app/onboarding/${nextStepSlug(step)}`)

  return user
}
