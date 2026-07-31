'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { EmailField } from '@/components/ui/validated-field'
import { cn } from '@/lib/cn'
import { cherryAvailable } from '@/lib/payments/cherry'

import { createBookingIntent, noteBookingCherryHandoff } from '../actions'
import { CardForm } from '../card-form'

export interface BookingSummary {
  clientName: string
  clientEmail: string | null
  serviceName: string
  treatmentArea: string | null
  providerName: string
  providerCredentials: string | null
  startTime: string
  durationMins: number
  price: string
  originalPrice: string
  discountType: string
  discountValue: string
}

export interface PolicyTerms {
  lateCancellationHours: number
  cancellationFeeAmount: string
  noShowFeePct: string
}

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const TIP_PRESETS = [0, 0.15, 0.2, 0.25]

export function BookingCheckout({
  token,
  booking,
  policy,
  cherryUrl,
}: {
  token: string
  booking: BookingSummary
  policy: PolicyTerms
  cherryUrl: string | null
}) {
  const [tipPreset, setTipPreset] = useState<number | 'custom'>(0)
  const [customTip, setCustomTip] = useState('')
  const [email, setEmail] = useState(booking.clientEmail ?? '')
  const [saveCard, setSaveCard] = useState(true)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [amount, setAmount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState(false)
  const [pending, start] = useTransition()

  const priceCents = Math.round(Number(booking.price) * 100)
  const tipCents =
    tipPreset === 'custom'
      ? Math.round((Number(customTip) || 0) * 100)
      : Math.round(priceCents * tipPreset)
  const totalCents = priceCents + tipCents

  // Gated on the SERVICE price, not the total. A tip is discretionary and 100% of it goes to
  // the provider, so financing one makes no sense — and letting a generous tip push a $180
  // service over Cherry's floor would offer a plan Cherry then declines.
  const showCherry = cherryAvailable(cherryUrl, booking.price)

  const discounted = booking.discountType !== 'none' && Number(booking.discountValue) > 0
  const noShowFee = (Number(booking.price) * Number(policy.noShowFeePct)).toFixed(2)

  const when = new Date(booking.startTime).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  })

  function beginPayment() {
    setError(null)
    start(async () => {
      const result = await createBookingIntent({
        token,
        tipAmount: tipCents / 100,
        clientEmail: email.trim() || null,
        saveCard,
      })
      if (result.error) {
        setError(result.error)
        return
      }
      setClientSecret(result.clientSecret ?? null)
      setAmount(result.amount ?? totalCents / 100)
    })
  }

  if (paid) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4 text-center">
        <div className="rounded-card border border-success/30 bg-success/10 p-8">
          <h1 className="text-xl font-semibold">Payment received</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            Thank you, {booking.clientName.split(' ')[0]}. You&rsquo;re all set for {when}.
          </p>
          <p className="mt-4 text-2xl font-semibold tabular-nums">{usd(amount)}</p>
        </div>
        <p className="text-xs text-ink-faint">
          A receipt has been emailed to you by Stripe. You can close this page.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-5">
      <section className="rounded-card border border-line bg-surface p-5">
        <h1 className="text-lg font-semibold">{booking.serviceName}</h1>
        {booking.treatmentArea && (
          <p className="mt-0.5 text-sm text-ink-muted">{booking.treatmentArea}</p>
        )}
        <p className="mt-2 text-sm text-ink-secondary">
          with {booking.providerName}
          {booking.providerCredentials && (
            <span className="text-ink-faint">, {booking.providerCredentials}</span>
          )}
        </p>
        <p className="mt-0.5 text-sm text-ink-muted tabular-nums">{when}</p>
        <p className="mt-0.5 text-xs text-ink-faint">{booking.durationMins} minutes</p>
      </section>

      {!clientSecret && (
        <>
          <section className="space-y-3 rounded-card border border-line bg-surface p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-secondary">Service</span>
              <span className="tabular-nums">
                {usd(booking.price)}
                {discounted && (
                  <span className="ml-2 text-xs text-ink-faint line-through">
                    {usd(booking.originalPrice)}
                  </span>
                )}
              </span>
            </div>

            <div className="space-y-2">
              <span className="block text-sm text-ink-secondary">Add a tip</span>
              <div className="flex flex-wrap gap-1.5">
                {TIP_PRESETS.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => setTipPreset(pct)}
                    aria-pressed={tipPreset === pct}
                    className={cn(
                      'rounded-field border px-3 py-2 text-xs tabular-nums transition-colors',
                      tipPreset === pct
                        ? 'border-gold bg-gold/10 text-gold'
                        : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-secondary',
                    )}
                  >
                    {pct === 0 ? 'No tip' : `${pct * 100}%`}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setTipPreset('custom')}
                  aria-pressed={tipPreset === 'custom'}
                  className={cn(
                    'rounded-field border px-3 py-2 text-xs transition-colors',
                    tipPreset === 'custom'
                      ? 'border-gold bg-gold/10 text-gold'
                      : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-secondary',
                  )}
                >
                  Other
                </button>
              </div>

              {tipPreset === 'custom' && (
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={customTip}
                  onChange={(e) => setCustomTip(e.target.value)}
                  aria-label="Tip amount"
                  placeholder="0.00"
                  className="w-32 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
              )}

              {/* Said plainly because providers are asked about it: the tip is not split. */}
              <p className="text-xs text-ink-faint">100% of your tip goes to your provider.</p>
            </div>

            <div className="flex items-baseline justify-between border-t border-line pt-3">
              <span className="font-medium">Total</span>
              <span className="text-xl font-semibold tabular-nums">{usd(totalCents / 100)}</span>
            </div>
          </section>

          <section className="space-y-3 rounded-card border border-line bg-surface p-5">
            <EmailField
              id="clientEmail"
              label="Email for your receipt"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              optional
            />

            {/* The consent artifact. Specific about what the card may be used for, sitting
                where it cannot be missed, and recorded with a version stamp when payment
                succeeds. A card kept on file without this is not chargeable. */}
            <label className="flex items-start gap-3 rounded-field border border-line p-3">
              <input
                type="checkbox"
                checked={saveCard}
                onChange={(e) => setSaveCard(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs text-ink-secondary">
                Keep my card on file. I authorise Melanite Laser Suite to charge it if I do not
                attend this appointment{' '}
                <span className="text-ink">({usd(noShowFee)})</span> or cancel within{' '}
                {policy.lateCancellationHours} hours of the start time{' '}
                <span className="text-ink">({usd(policy.cancellationFeeAmount)})</span>. No other
                charges will be made without my consent.
              </span>
            </label>

            {!saveCard && (
              <p className="text-xs text-warning">
                Without a card on file your provider may ask you to reschedule in person.
              </p>
            )}
          </section>

          {error && <Notice>{error}</Notice>}

          <Button block onClick={beginPayment} disabled={pending}>
            {pending ? 'Preparing…' : `Continue to payment · ${usd(totalCents / 100)}`}
          </Button>

          {/* Beside the card option, not behind it. Somebody looking at a four-figure treatment
              is exactly who wants to finance it, and an option discovered only after committing
              to a card form is one that goes unnoticed. */}
          {showCherry && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-line" />
                <span className="text-xs uppercase tracking-wide text-ink-faint">or</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              {/* Recorded before they leave, so the link stops looking like one nobody opened.
                  Fire-and-forget on purpose: a failed tracking write must never stand between a
                  client and Cherry. The navigation is a real link rather than JS, so it works
                  even if the action never resolves. */}
              <a
                href={cherryUrl!}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  void noteBookingCherryHandoff(token)
                }}
                className="block rounded-control border border-line-strong px-[18px] py-3 text-center text-[13px] font-bold tracking-[0.3px] text-ink-secondary transition-colors hover:border-ink-faint hover:bg-overlay"
              >
                Pay over time with Cherry →
              </a>
              <p className="text-center text-xs text-ink-faint">
                Cherry offers monthly payment plans, and checking your options doesn&rsquo;t
                affect your credit score. You&rsquo;d finance the{' '}
                {usd(booking.price)} treatment — a tip isn&rsquo;t included. You&rsquo;ll finish
                on Cherry&rsquo;s site, then tell your provider.
              </p>
            </div>
          )}
        </>
      )}

      {clientSecret && (
        <section className="space-y-4 rounded-card border border-line bg-surface p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-ink-secondary">Total</span>
            <span className="text-xl font-semibold tabular-nums">{usd(amount)}</span>
          </div>
          <CardForm
            clientSecret={clientSecret}
            amount={amount}
            onPaid={() => setPaid(true)}
          />
          <button
            type="button"
            onClick={() => setClientSecret(null)}
            className="w-full text-center text-xs text-ink-faint underline-offset-4 hover:underline"
          >
            Change tip or email
          </button>
        </section>
      )}
    </div>
  )
}
