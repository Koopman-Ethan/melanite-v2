import { toCents } from '@/lib/money'

// How much to refund, and against which charges.
//
// Pulled out of the admin queue action for two reasons. It was the only part of a refund that
// is pure arithmetic surrounded by Stripe calls, so it could not be tested where it stood; and
// it was doing money in floating-point dollars — `remaining -= take` on Numbers — while the
// rest of the app had already settled on integer cents. One enrolment can carry a deposit and
// a balance, so a partial refund has to be spread across two charges, and spreading it wrong
// means refunding the wrong amount to a real person.

export interface RefundableCharge {
  paymentIntentId: string
  /** Money as it comes off the ledger, e.g. "500.00". */
  gross: string
  entryType: string
}

export interface PlannedRefund {
  paymentIntentId: string
  amountCents: number
}

export type RefundPlan =
  | { error: string }
  | { paidCents: number; totalCents: number; charges: PlannedRefund[] }

/**
 * Works out which charges to reverse and by how much.
 *
 * `requestedCents` of null means "everything still outstanding".
 *
 * Newest charge first. Refunding a partial amount against the most recent payment is what a
 * person expects when they say "give back the balance" — and it keeps the deposit intact,
 * which is usually the one tied to a place on a course.
 */
export function planRefund(
  entries: RefundableCharge[],
  requestedCents: number | null,
): RefundPlan {
  const purchases = entries.filter((e) => e.entryType === 'purchase' && e.paymentIntentId)
  if (purchases.length === 0) {
    return { error: 'No Stripe payment is recorded for this student — refund by hand.' }
  }

  // Purchases and refunds ONLY.
  //
  // The original summed every row attached to the subject, so any other ledger entry — a fee,
  // a payout — counted as money that could be handed back. It would have reported more as
  // refundable than was ever charged, and then failed partway through the Stripe loop with a
  // partial refund already issued.
  const paidCents = entries.reduce((sum, e) => {
    if (e.entryType === 'purchase') return sum + toCents(e.gross)
    if (e.entryType === 'refund') return sum - toCents(e.gross)
    return sum
  }, 0)

  const totalCents = requestedCents === null ? paidCents : requestedCents

  if (!(totalCents > 0)) return { error: 'Enter an amount greater than zero.' }
  if (totalCents > paidCents) {
    return { error: `That is more than the ${(paidCents / 100).toFixed(2)} paid.` }
  }

  const charges: PlannedRefund[] = []
  let remaining = totalCents

  for (const purchase of [...purchases].reverse()) {
    if (remaining <= 0) break
    const take = Math.min(remaining, toCents(purchase.gross))
    if (take <= 0) continue
    charges.push({ paymentIntentId: purchase.paymentIntentId, amountCents: take })
    remaining -= take
  }

  // Reachable when earlier refunds have already reversed part of a charge: `paidCents` says
  // money is owed back, but the individual purchase rows no longer have that much left on
  // them. Refusing beats asking Stripe for a refund it will reject halfway through a loop.
  if (remaining > 0) {
    return { error: 'Some of that has already been refunded. Refund a smaller amount.' }
  }

  return { paidCents, totalCents, charges }
}
