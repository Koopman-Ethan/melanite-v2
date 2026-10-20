'use server'

import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import {
  activePromotions,
  createPromotion,
  endPromotionNow,
} from '@/lib/rental/promotions'
import { getLiveSchedule, publishSchedule, type PublishInput } from '@/lib/rental/schedule'
import { validatePromotion, type DraftPromotion } from '@/lib/validate/promotion'
import { todayInDenver } from '@/lib/validation'

export interface PricingState {
  error?: string
  success?: string
  /** The promotion just created, if one was. The create form uses it as a React `key` so a
   *  success discards the filled-in fields by remounting.
   *
   *  AN ID RATHER THAN A FLAG, because the key has to CHANGE on every success and a boolean
   *  does not. Nor does the success sentence: the same name and dates on a different service
   *  reads identically, and the second promotion would leave the form full. An id is the only
   *  thing here guaranteed distinct every time. */
  createdId?: string
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

/**
 * Starts a promotion.
 *
 * SEPARATE FROM PUBLISHING, and the separation is the point. Publishing a schedule asks every
 * provider to accept the new prices before they can book again; a promotion asks nobody,
 * because it can only ever charge them LESS than the ceiling they already accepted. Running
 * one through the pricing editor would lock everybody out twice — once starting, once ending.
 *
 * Every rule lives in `validatePromotion`, so the form can refuse before the round trip and
 * this still refuses if somebody posts past it.
 */
export async function startPromotion(
  _prev: PricingState,
  formData: FormData,
): Promise<PricingState> {
  const admin = await requireAdmin()

  const kind = String(formData.get('kind') ?? '')
  if (kind !== 'percent' && kind !== 'amount') return { error: 'Pick a percentage or an amount.' }

  // A percentage is a whole number; an amount is dollars, converted here exactly as the
  // schedule's figures are, so there is one implementation of money crossing the wire.
  const raw = String(formData.get('value') ?? '').trim()
  const value = kind === 'percent' ? Number(raw) : dollarsToCents(raw)
  if (value === null || !Number.isFinite(value)) return { error: 'That is not a number.' }

  const tierKey = String(formData.get('tierKey') ?? '')

  const draft: DraftPromotion = {
    name: String(formData.get('name') ?? ''),
    // The sentinel is the empty string because a <select> cannot carry null.
    tierKey: tierKey === '' ? null : tierKey,
    kind,
    value: Math.round(value),
    startsOn: String(formData.get('startsOn') ?? ''),
    endsOn: String(formData.get('endsOn') ?? ''),
  }

  const [schedule, existing] = await Promise.all([getLiveSchedule(), activePromotions()])

  const invalid = validatePromotion(draft, {
    today: todayInDenver(),
    tiers: schedule.entries,
    existing,
  })
  if (invalid) return { error: invalid }

  const { id } = await createPromotion(draft, admin.id)

  revalidateEverythingPriced()

  return {
    createdId: id,
    success: `“${draft.name.trim()}” is running from ${draft.startsOn} to ${draft.endsOn}. Nobody has to accept anything.`,
  }
}

/** Stops one, or cancels one that had not started. See `endPromotionNow` for why those are
 *  different operations rather than one with a flag. */
export async function endPromotion(id: string): Promise<PricingState> {
  const admin = await requireAdmin()

  const result = await endPromotionNow(id, admin.id)
  if (result === 'not_running') return { error: 'That promotion had already finished.' }

  revalidateEverythingPriced()

  return {
    success:
      result === 'cancelled'
        ? 'Cancelled — it never started, so nothing was quoted at that price.'
        : 'Ended. Sessions today keep the promotional price; tomorrow is back to the schedule.',
  }
}

/** The surfaces that quote or charge a rental fee. The same four `publishPricing` clears,
 *  because a promotion changes exactly the same numbers a price change does. */
function revalidateEverythingPriced(): void {
  revalidatePath('/app/admin/pricing')
  revalidatePath('/app/book')
  revalidatePath('/app/appointments')
  revalidatePath('/app/account')
}
