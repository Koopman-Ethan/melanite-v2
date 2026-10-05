'use server'

import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { publishSchedule, type PublishInput } from '@/lib/rental/schedule'

export interface PricingState {
  error?: string
  success?: string
}

/**
 * Publishes an edited fee schedule.
 *
 * Takes every tier, not only the changed ones — see `publishSchedule` for why a version has to
 * be a complete picture rather than a patch.
 *
 * The figures arrive as DOLLAR strings from the form and are converted here, once. Letting
 * cents cross the wire would mean the form doing money arithmetic, which is where the penny
 * disagreements in this codebase have always started.
 */
export async function publishPricing(
  _prev: PricingState,
  formData: FormData,
): Promise<PricingState> {
  const admin = await requireAdmin()

  const note = String(formData.get('note') ?? '').trim()
  const keys = formData.getAll('tierKey').map(String)

  if (keys.length === 0) return { error: 'Nothing to publish.' }

  const entries: PublishInput[] = []

  for (const key of keys) {
    const fee = dollarsToCents(formData.get(`fee:${key}`))
    const low = dollarsToCents(formData.get(`low:${key}`))
    const high = dollarsToCents(formData.get(`high:${key}`))

    if (fee === null) return { error: `${key}: the rental fee is not a number.` }
    if (low === null || high === null) {
      return { error: `${key}: the suggested price is not a number.` }
    }

    entries.push({
      tierKey: key,
      singleCents: fee,
      suggestedLowCents: low,
      suggestedHighCents: high,
    })
  }

  const result = await publishSchedule(entries, note, admin.id)
  if ('error' in result) return { error: result.error }

  // Every surface that prices anything. A provider sitting on the booking page should see the
  // new figure, and the gate that asks them to accept it, on their next navigation.
  revalidatePath('/app/admin/pricing')
  revalidatePath('/app/book')
  revalidatePath('/app/account')
  revalidatePath('/onboarding/billing')

  return {
    success: `Published schedule v${result.version}. Providers will be asked to accept it before their next booking.`,
  }
}

/** "35", "35.00", "$35" → 3500. Null when it is not a number at all.
 *
 *  Rounded rather than truncated, and done on the server so there is one implementation of it.
 *  A price typed as "35.005" is a typo; rounding it is kinder than silently dropping the half
 *  penny, and the check constraints catch anything genuinely wrong. */
function dollarsToCents(raw: FormDataEntryValue | null): number | null {
  const text = String(raw ?? '').trim().replace(/^\$/, '').replace(/,/g, '')
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}
