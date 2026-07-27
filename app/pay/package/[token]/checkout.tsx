'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'

import { createPackageIntent } from '../../actions'
import { CardForm } from '../../card-form'

export interface PackageSummary {
  templateName: string
  providerName: string
  providerCredentials: string | null
  clientName: string | null
  clientEmail: string | null
  price: string
  expiresAfterDays: number | null
  items: { serviceName: string; quantity: number; perSessionValue: string }[]
}

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export function PackageCheckout({
  token,
  pkg,
  cherryUrl,
}: {
  token: string
  pkg: PackageSummary
  cherryUrl: string | null
}) {
  const [name, setName] = useState(pkg.clientName ?? '')
  const [email, setEmail] = useState(pkg.clientEmail ?? '')
  const [saveCard, setSaveCard] = useState(true)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [amount, setAmount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState(false)
  const [pending, start] = useTransition()

  const sessions = pkg.items.reduce((n, i) => n + i.quantity, 0)
  const listValue = pkg.items.reduce(
    (sum, i) => sum + Number(i.perSessionValue) * i.quantity,
    0,
  )
  const saving = listValue - Number(pkg.price)

  function beginPayment() {
    setError(null)
    start(async () => {
      const result = await createPackageIntent({
        token,
        tipAmount: 0,
        clientName: name.trim() || null,
        clientEmail: email.trim() || null,
        saveCard,
      })
      if (result.error) {
        setError(result.error)
        return
      }
      setClientSecret(result.clientSecret ?? null)
      setAmount(result.amount ?? Number(pkg.price))
    })
  }

  if (paid) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4 text-center">
        <div className="rounded-card border border-success/30 bg-success/10 p-8">
          <h1 className="text-xl font-semibold">Package purchased</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            {sessions} {sessions === 1 ? 'session is' : 'sessions are'} now on your account with{' '}
            {pkg.providerName}.
          </p>
          <p className="mt-4 text-2xl font-semibold tabular-nums">{usd(amount)}</p>
        </div>
        <p className="text-xs text-ink-faint">
          Book your sessions with your provider as usual — your balance is applied automatically.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-5">
      <section className="rounded-card border border-line bg-surface p-5">
        <h1 className="text-lg font-semibold">{pkg.templateName}</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          with {pkg.providerName}
          {pkg.providerCredentials && (
            <span className="text-ink-faint">, {pkg.providerCredentials}</span>
          )}
        </p>

        <ul className="mt-4 space-y-2 border-t border-line pt-4">
          {pkg.items.map((item) => (
            <li key={item.serviceName} className="flex items-baseline justify-between text-sm">
              <span>
                <span className="tabular-nums text-ink">{item.quantity}×</span>{' '}
                {item.serviceName}
              </span>
              <span className="text-ink-faint tabular-nums">
                {usd(item.perSessionValue)} each
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex items-baseline justify-between border-t border-line pt-4">
          <span className="font-medium">Package price</span>
          <span className="text-xl font-semibold tabular-nums">{usd(pkg.price)}</span>
        </div>

        {saving > 0 && (
          <p className="mt-1 text-right text-xs text-success tabular-nums">
            Saves {usd(saving)} against booking individually
          </p>
        )}

        {pkg.expiresAfterDays && (
          <p className="mt-3 text-xs text-ink-faint">
            Sessions expire {pkg.expiresAfterDays} days after purchase.
          </p>
        )}
      </section>

      {!clientSecret && (
        <>
          <section className="space-y-3 rounded-card border border-line bg-surface p-5">
            <Field
              id="clientName"
              label="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Field
              id="clientEmail"
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              hint="Your package balance is tracked against this address"
            />

            <label className="flex items-start gap-3 rounded-field border border-line p-3">
              <input
                type="checkbox"
                checked={saveCard}
                onChange={(e) => setSaveCard(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs text-ink-secondary">
                Keep my card on file. I authorise Melanite Laser Suite to charge it for missed
                appointments or late cancellations, as set out in the appointment policy. No
                other charges will be made without my consent.
              </span>
            </label>
          </section>

          {error && <Notice>{error}</Notice>}

          <Button block onClick={beginPayment} disabled={pending || !email.trim()}>
            {pending ? 'Preparing…' : `Pay by card · ${usd(pkg.price)}`}
          </Button>

          {/* Cherry sits beside the card option, not behind it. A four-figure package is
              exactly the purchase somebody wants to finance, and burying that behind the card
              form is how the option goes unnoticed. Hidden entirely when unconfigured — a
              button that goes nowhere is worse than no button. */}
          {cherryUrl && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-line" />
                <span className="text-xs uppercase tracking-wide text-ink-faint">or</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              <a
                href={cherryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-control border border-line-strong px-[18px] py-3 text-center text-[13px] font-bold tracking-[0.3px] text-ink-secondary transition-colors hover:border-ink-faint hover:bg-overlay"
              >
                Pay over time with Cherry →
              </a>
              <p className="text-center text-xs text-ink-faint">
                Cherry offers monthly payment plans, with no impact on your credit score to
                check your options. You&rsquo;ll finish on Cherry&rsquo;s site, then tell your
                provider.
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
          <CardForm clientSecret={clientSecret} amount={amount} onPaid={() => setPaid(true)} />
          <button
            type="button"
            onClick={() => setClientSecret(null)}
            className="w-full text-center text-xs text-ink-faint underline-offset-4 hover:underline"
          >
            Change your details
          </button>
        </section>
      )}
    </div>
  )
}
