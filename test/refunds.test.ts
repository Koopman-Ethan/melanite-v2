import { describe, expect, it } from 'vitest'

import { planRefund, type RefundableCharge } from '@/lib/refunds'

// Refund arithmetic. This decides how much real money goes back to a real person, across
// however many charges they made, and it had never been tested — it sat inline in an admin
// action between two Stripe calls, in floating-point dollars.

const purchase = (id: string, gross: string): RefundableCharge => ({
  paymentIntentId: id,
  gross,
  entryType: 'purchase',
})

const refund = (id: string, gross: string): RefundableCharge => ({
  paymentIntentId: id,
  gross,
  entryType: 'refund',
})

/** The usual shape: a deposit, then the balance. */
const DEPOSIT_AND_BALANCE = [purchase('pi_deposit', '500.00'), purchase('pi_balance', '900.00')]

describe('planRefund', () => {
  it('refuses when nothing was paid through Stripe', () => {
    // Cash and Cherry payments land on the ledger with no payment intent. There is nothing to
    // reverse through the API, and saying so beats a confusing Stripe error.
    const plan = planRefund([], null)
    expect('error' in plan && plan.error).toMatch(/no stripe payment/i)
  })

  it('refunds everything paid when no amount is given', () => {
    const plan = planRefund(DEPOSIT_AND_BALANCE, null)
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.paidCents).toBe(140000)
    expect(plan.totalCents).toBe(140000)
    // Both charges, because a full refund cannot come out of one of them.
    expect(plan.charges).toEqual([
      { paymentIntentId: 'pi_balance', amountCents: 90000 },
      { paymentIntentId: 'pi_deposit', amountCents: 50000 },
    ])
  })

  it('takes a partial refund off the most recent charge first', () => {
    const plan = planRefund(DEPOSIT_AND_BALANCE, 30000)
    if ('error' in plan) throw new Error(plan.error)

    // The deposit is left alone — it is the one usually tied to a place on the course.
    expect(plan.charges).toEqual([{ paymentIntentId: 'pi_balance', amountCents: 30000 }])
  })

  it('spills across charges when one is not enough', () => {
    const plan = planRefund(DEPOSIT_AND_BALANCE, 100000)
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.charges).toEqual([
      { paymentIntentId: 'pi_balance', amountCents: 90000 },
      { paymentIntentId: 'pi_deposit', amountCents: 10000 },
    ])
    // The parts always sum to exactly what was asked for. Off by a cent here is off by a cent
    // in somebody's bank account.
    expect(plan.charges.reduce((n, c) => n + c.amountCents, 0)).toBe(100000)
  })

  it('refuses more than was paid', () => {
    const plan = planRefund(DEPOSIT_AND_BALANCE, 150000)
    expect('error' in plan && plan.error).toMatch(/more than the 1400\.00 paid/i)
  })

  it('refuses zero and negative amounts', () => {
    expect('error' in planRefund(DEPOSIT_AND_BALANCE, 0)).toBe(true)
    expect('error' in planRefund(DEPOSIT_AND_BALANCE, -5000)).toBe(true)
  })

  it('counts earlier refunds against what is left', () => {
    // $1400 paid, $400 already returned. Only $1000 remains refundable, and asking for the
    // original total must not be allowed a second time.
    const entries = [...DEPOSIT_AND_BALANCE, refund('pi_balance', '400.00')]

    const plan = planRefund(entries, null)
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.paidCents).toBe(100000)

    expect('error' in planRefund(entries, 140000)).toBe(true)
  })

  it('refuses when the charges cannot cover what the ledger says is owed', () => {
    // The ledger can show a positive balance while the individual charges have already been
    // reversed past the point of covering it. Refusing beats asking Stripe for something it
    // will reject partway through a loop, leaving a partial refund nobody recorded.
    const entries = [
      purchase('pi_a', '100.00'),
      purchase('pi_b', '100.00'),
      refund('pi_b', '100.00'),
    ]
    // $100 genuinely remains, and pi_a can cover it.
    const ok = planRefund(entries, 10000)
    expect('error' in ok).toBe(false)

    // More than any remaining charge can absorb.
    expect('error' in planRefund(entries, 20000)).toBe(true)
  })

  it('handles money that does not divide cleanly', () => {
    // $33.33 three times. Nothing here should produce a rounding artefact, because it is all
    // integers from the start — the old version subtracted Numbers.
    const entries = [
      purchase('pi_1', '33.33'),
      purchase('pi_2', '33.33'),
      purchase('pi_3', '33.33'),
    ]
    const plan = planRefund(entries, null)
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.paidCents).toBe(9999)
    expect(plan.charges.reduce((n, c) => n + c.amountCents, 0)).toBe(9999)
  })

  it('ignores ledger rows that are not purchases', () => {
    // A fee or a payout row attached to the same subject must not be treated as something that
    // can be refunded.
    const entries: RefundableCharge[] = [
      purchase('pi_real', '100.00'),
      { paymentIntentId: 'pi_fee', gross: '50.00', entryType: 'fee' },
    ]
    const plan = planRefund(entries, null)
    if ('error' in plan) throw new Error(plan.error)

    expect(plan.charges).toEqual([{ paymentIntentId: 'pi_real', amountCents: 10000 }])
  })
})
