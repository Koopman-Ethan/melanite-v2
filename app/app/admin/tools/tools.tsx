'use client'

import { useState, useTransition, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { EmailField, PhoneField } from '@/components/ui/validated-field'
import { cn } from '@/lib/cn'
import type { ServiceOption } from '@/lib/db/queries/admin-tools'

import {
  createManualBooking,
  inviteProvider,
  inviteUrl,
  recordBookingPayment,
  recordMembershipPayment,
  resendInvite,
  revokeInvite,
  type ToolState,
} from './actions'

// The admin escape hatch, as three narrow tools rather than one row editor.
//
// Each maps to something that actually happens and currently has nowhere to go: a client
// financed with Cherry or handed over a Groupon voucher; a provider paid Keoni for six months
// of medical direction directly; an appointment was arranged over the phone and never entered.
// A generic table editor would cover all three and quietly destroy the ledger's invariants
// while doing it.

export interface UnpaidBookingView {
  id: string
  clientName: string
  providerName: string
  serviceName: string
  startTime: string
  price: string
  status: string
  /** Set when the provider already said how the client paid. */
  externalMethod: string | null
}

export interface ProviderView {
  id: string
  name: string
  email: string
  medicalDirectorStatus: string
}

const METHODS = [
  { value: 'cherry', label: 'Cherry' },
  { value: 'groupon', label: 'Groupon' },
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'other', label: 'Other' },
] as const

type Method = (typeof METHODS)[number]['value']

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const dateTimeLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  })

const selectClass =
  'w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-gold'

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-ink-secondary">{label}</span>
      {children}
    </label>
  )
}

function MethodPicker({ value, onChange }: { value: Method; onChange: (m: Method) => void }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-ink-secondary">How was it paid?</span>
      <div className="flex flex-wrap gap-1.5">
        {METHODS.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => onChange(m.value)}
            aria-pressed={value === m.value}
            className={cn(
              'rounded-field border px-3 py-2 text-xs transition-colors',
              value === m.value
                ? 'border-gold bg-gold/10 text-gold'
                : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-secondary',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Result({ state }: { state: ToolState | null }) {
  if (!state) return null
  if (state.error) return <Notice>{state.error}</Notice>
  if (state.success) return <Notice tone="success">{state.success}</Notice>
  return null
}

// ---------------------------------------------------------------------------

function PaymentTool({ unpaid, sharePct }: { unpaid: UnpaidBookingView[]; sharePct: number }) {
  const [bookingId, setBookingId] = useState('')
  const [method, setMethod] = useState<Method>('cherry')
  const [amount, setAmount] = useState('')
  const [tip, setTip] = useState('')
  const [reference, setReference] = useState('')
  const [providerKeepsAll, setProviderKeepsAll] = useState(false)
  const [note, setNote] = useState('')
  const [state, setState] = useState<ToolState | null>(null)
  const [pending, start] = useTransition()

  const booking = unpaid.find((b) => b.id === bookingId)

  const grossCents = Math.round((Number(amount) || 0) * 100)
  const tipCents = Math.round((Number(tip) || 0) * 100)
  const payoutCents = providerKeepsAll
    ? grossCents + tipCents
    : Math.round(grossCents * sharePct) + tipCents
  const cutCents = grossCents + tipCents - payoutCents

  function submit() {
    start(async () => {
      const result = await recordBookingPayment({
        bookingId,
        method,
        grossAmount: Number(amount),
        tipAmount: Number(tip) || 0,
        externalReference: reference || null,
        providerPayoutOverride: providerKeepsAll ? payoutCents / 100 : null,
        note: note || null,
      })
      setState(result)
      if (result.success) {
        setBookingId('')
        setAmount('')
        setTip('')
        setReference('')
        setNote('')
        setProviderKeepsAll(false)
      }
    })
  }

  if (unpaid.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-line p-8 text-center text-sm text-ink-muted">
        Every appointment has a payment recorded against it. Nothing to reconcile.
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-muted">
        These appointments have no money recorded against them. Some are genuinely unpaid;
        others were settled by a route the app never saw.
      </p>

      <Labeled label="Appointment">
        <select
          value={bookingId}
          onChange={(e) => {
            setBookingId(e.target.value)
            const b = unpaid.find((x) => x.id === e.target.value)
            // Prefill with what was charged, since it is right most of the time. Editable
            // because Groupon and Cherry both remit something other than list price.
            setAmount(b ? Number(b.price).toFixed(2) : '')
            // And with the method the PROVIDER already stated at booking. Keoni confirms a
            // figure rather than reconstructing one — which is the entire point of asking the
            // provider for it in the first place.
            if (b?.externalMethod) setMethod(b.externalMethod as Method)
            setState(null)
          }}
          className={selectClass}
        >
          <option value="">Choose an appointment…</option>
          {unpaid.map((b) => (
            <option key={b.id} value={b.id}>
              {dateTimeLabel(b.startTime)} · {b.clientName} · {b.serviceName} · {usd(b.price)} ·{' '}
              {b.providerName}
              {b.externalMethod ? ` · provider said ${b.externalMethod}` : ''}
            </option>
          ))}
        </select>
      </Labeled>

      {booking && (
        <>
          <MethodPicker value={method} onChange={setMethod} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="pay-amount"
              label="Amount collected"
              type="number"
              min={0}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              hint={`Charged ${usd(booking.price)}`}
            />
            <Field
              id="pay-tip"
              label="Tip"
              type="number"
              min={0}
              step={0.01}
              value={tip}
              onChange={(e) => setTip(e.target.value)}
              hint="Goes entirely to the provider"
            />
          </div>

          <Field
            id="pay-reference"
            label="Reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            hint="Cherry contract, Groupon voucher code, check number — optional, but it is what makes this reconcilable later"
          />

          <label className="flex items-start gap-3 rounded-field border border-line p-3">
            <input
              type="checkbox"
              checked={providerKeepsAll}
              onChange={(e) => setProviderKeepsAll(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-sm">
              <span className="font-medium text-ink-secondary">The provider keeps all of it</span>
              <span className="mt-0.5 block text-xs text-ink-faint">
                For vouchers the provider sold and collected on directly. Melanite&apos;s share
                is zero — applying the usual split would book revenue that never arrived.
              </span>
            </span>
          </label>

          <div className="rounded-card border border-line p-4 text-sm">
            <div className="flex justify-between tabular-nums">
              <span className="text-ink-muted">Provider payout</span>
              <span className="font-medium">{usd(payoutCents / 100)}</span>
            </div>
            <div className="mt-1.5 flex justify-between tabular-nums">
              <span className="text-ink-muted">Melanite</span>
              <span className="font-medium">{usd(cutCents / 100)}</span>
            </div>
            <p className="mt-2.5 text-xs text-ink-faint">
              Payout is left pending — Stripe Connect cannot settle money it never received, so
              this one has to be paid out by hand.
            </p>
          </div>

          <Field
            id="pay-note"
            label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <Result state={state} />

          <Button onClick={submit} disabled={pending || !amount || Number(amount) <= 0}>
            {pending ? 'Recording…' : 'Record payment'}
          </Button>
        </>
      )}

      {!booking && <Result state={state} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

function MembershipTool({ providers }: { providers: ProviderView[] }) {
  const [providerId, setProviderId] = useState('')
  const [amount, setAmount] = useState('')
  const [months, setMonths] = useState('1')
  const [method, setMethod] = useState<Method>('cash')
  const [activateGate, setActivateGate] = useState(true)
  const [note, setNote] = useState('')
  const [state, setState] = useState<ToolState | null>(null)
  const [pending, start] = useTransition()

  const provider = providers.find((p) => p.id === providerId)

  function submit() {
    start(async () => {
      const result = await recordMembershipPayment({
        providerId,
        amount: Number(amount),
        months: Number(months),
        method,
        note: note || null,
        activateGate,
      })
      setState(result)
      if (result.success) {
        setProviderId('')
        setAmount('')
        setMonths('1')
        setNote('')
      }
    })
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-muted">
        For medical direction paid straight to Keoni — several months at once, outside Stripe.
        Recording it books the revenue and extends the provider&apos;s coverage.
      </p>

      <Labeled label="Provider">
        <select
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value)
            setState(null)
          }}
          className={selectClass}
        >
          <option value="">Choose a provider…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.email}
            </option>
          ))}
        </select>
      </Labeled>

      {provider && (
        <>
          {provider.medicalDirectorStatus === 'active' && (
            <Notice tone="warning">
              This provider&apos;s medical director status is already active. Recording another
              payment extends their coverage from the current renewal date.
            </Notice>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="md-amount"
              label="Total paid"
              type="number"
              min={0}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Field
              id="md-months"
              label="Months covered"
              type="number"
              min={1}
              step={1}
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
          </div>

          <MethodPicker value={method} onChange={setMethod} />

          <label className="flex items-start gap-3 rounded-field border border-line p-3">
            <input
              type="checkbox"
              checked={activateGate}
              onChange={(e) => setActivateGate(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-sm">
              <span className="font-medium text-ink-secondary">
                Set their medical director status to active
              </span>
              <span className="mt-0.5 block text-xs text-ink-faint">
                Leave this off if the payment covers a period that has already passed — it is
                one of the three gates on booking.
              </span>
            </span>
          </label>

          <Field id="md-note" label="Note" value={note} onChange={(e) => setNote(e.target.value)} />

          <Result state={state} />

          <Button
            onClick={submit}
            disabled={pending || !amount || Number(amount) <= 0 || Number(months) < 1}
          >
            {pending ? 'Recording…' : 'Record payment'}
          </Button>
        </>
      )}

      {!provider && <Result state={state} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

function BookingTool({
  providers,
  serviceMap,
}: {
  providers: ProviderView[]
  serviceMap: Record<string, ServiceOption[]>
}) {
  const [providerId, setProviderId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('')
  const [clientEmail, setClientEmail] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [price, setPrice] = useState('')
  const [comped, setComped] = useState(false)
  const [note, setNote] = useState('')
  const [state, setState] = useState<ToolState | null>(null)
  const [pending, start] = useTransition()

  const options = serviceMap[providerId] ?? []
  const service = options.find((s) => s.id === serviceId)

  function submit() {
    start(async () => {
      const result = await createManualBooking({
        providerId,
        providerServiceId: serviceId,
        clientName,
        clientPhone: clientPhone || null,
        clientEmail: clientEmail || null,
        date,
        time,
        price: comped ? 0 : Number(price),
        paymentSource: comped ? 'comped' : 'checkout_link',
        note: note || null,
      })
      setState(result)
      if (result.success) {
        setClientName('')
        setClientPhone('')
        setClientEmail('')
        setTime('')
        setNote('')
      }
    })
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-muted">
        Enters an appointment on a provider&apos;s behalf. The laser is still checked for
        collisions, but the provider&apos;s booking gates are not — an appointment that already
        happened should not be blocked by a license that lapsed afterwards.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label="Provider">
          <select
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value)
              setServiceId('')
              setPrice('')
              setState(null)
            }}
            className={selectClass}
          >
            <option value="">Choose a provider…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Labeled>

        <Labeled label="Service">
          <select
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value)
              const s = options.find((x) => x.id === e.target.value)
              setPrice(s ? Number(s.price).toFixed(2) : '')
            }}
            disabled={!providerId}
            className={cn(selectClass, !providerId && 'opacity-50')}
          >
            <option value="">
              {providerId && options.length === 0
                ? 'This provider has no active services'
                : 'Choose a service…'}
            </option>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {usd(s.price)} · {s.durationMins} min
              </option>
            ))}
          </select>
        </Labeled>
      </div>

      {service && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Date">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={selectClass}
              />
            </Labeled>
            <Labeled label="Start time">
              <input
                type="time"
                step={900}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={selectClass}
              />
            </Labeled>
          </div>
          <p className="-mt-2 text-xs text-ink-faint">
            Mountain Time. Runs {service.durationMins} minutes. A date in the past is recorded as
            a completed appointment.
          </p>

          <Field
            id="mb-name"
            label="Client name"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            required
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <PhoneField
              id="mb-phone"
              label="Phone"
              value={clientPhone}
              onChange={setClientPhone}
              optional
            />
            <EmailField
              id="mb-email"
              label="Email"
              value={clientEmail}
              onChange={setClientEmail}
              optional
              hint="Links to an existing client record, or creates one"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="mb-price"
              label="Price"
              type="number"
              min={0}
              step={0.01}
              value={comped ? '0.00' : price}
              disabled={comped}
              onChange={(e) => setPrice(e.target.value)}
            />
            <label className="flex items-center gap-3 self-end rounded-field border border-line px-3 py-2.5">
              <input
                type="checkbox"
                checked={comped}
                onChange={(e) => setComped(e.target.checked)}
              />
              <span className="text-sm text-ink-secondary">Comped</span>
            </label>
          </div>

          <Field id="mb-note" label="Note" value={note} onChange={(e) => setNote(e.target.value)} />

          {/* Stated rather than assumed: this writes the appointment only. Payment is a
              separate act, and pretending otherwise is what put v1's revenue $2,000 out. */}
          <p className="text-xs text-ink-faint">
            This creates the appointment only — no payment is recorded and no checkout link is
            sent. Use the payment tool once the money arrives.
          </p>

          <Result state={state} />

          <Button onClick={submit} disabled={pending || !clientName || !date || !time}>
            {pending ? 'Creating…' : 'Create appointment'}
          </Button>
        </>
      )}

      {!service && <Result state={state} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

export interface InviteView {
  id: string
  email: string
  status: string
  sentAt: string
  expiresAt: string
  invitedBy: string | null
  isExpired: boolean
}

/** Invite a provider, and see the ones still outstanding.
 *
 *  There is no self-service signup — a provider is someone Keoni has met, usually at a training
 *  course — so this is the only door into the system. */
function InviteTool({ invites }: { invites: InviteView[] }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<(ToolState & { url?: string }) | null>(null)
  const [pending, start] = useTransition()

  const outstanding = invites.filter((i) => i.status === 'pending' && !i.isExpired)
  const rest = invites.filter((i) => !(i.status === 'pending' && !i.isExpired))

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-muted">
        Sends a one-time link that expires in 7 days. The provider sets their own password —
        nobody here ever sees it. If the email doesn&rsquo;t arrive, use Show link or Resend
        rather than sending a second invite: two live links for one person means whichever they
        happen to click decides their account.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <Field
            id="inviteEmail"
            label="Their email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="provider@example.com"
          />
        </div>
        <Button
          disabled={pending || !email.trim()}
          onClick={() =>
            start(async () => {
              const result = await inviteProvider(email)
              setState(result)
              if (result.success) setEmail('')
            })
          }
        >
          {pending ? 'Sending…' : 'Send invite'}
        </Button>
      </div>

      {state?.error && <Notice>{state.error}</Notice>}
      {state?.success && <Notice tone="success">{state.success}</Notice>}
      {/* Shown whichever way it went — email may not be configured, and a link the admin cannot
          see is a link nobody can send. */}
      {state?.url && (
        <p className="break-all rounded-field border border-line bg-overlay p-3 text-xs text-ink-secondary">
          {state.url}
        </p>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          Awaiting acceptance
        </h3>
        {outstanding.length === 0 ? (
          <p className="rounded-card border border-dashed border-line p-6 text-center text-sm text-ink-muted">
            No invites outstanding.
          </p>
        ) : (
          <ul className="space-y-2">
            {outstanding.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line p-3"
              >
                <div className="min-w-0">
                  <span className="text-sm">{invite.email}</span>
                  <span className="ml-2 text-xs text-ink-faint">
                    expires{' '}
                    {new Date(invite.expiresAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                    {invite.invitedBy && ` · invited by ${invite.invitedBy}`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => start(async () => setState(await inviteUrl(invite.id)))}
                  >
                    Show link
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => start(async () => setState(await resendInvite(invite.id)))}
                  >
                    Resend
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => start(async () => setState(await revokeInvite(invite.id)))}
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {rest.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Accepted, expired and revoked
          </h3>
          <ul className="space-y-1.5">
            {rest.map((invite) => (
              <li key={invite.id} className="flex justify-between gap-3 text-xs text-ink-muted">
                <span>{invite.email}</span>
                <span className="text-ink-faint">
                  {invite.status === 'accepted'
                    ? 'accepted'
                    : invite.isExpired
                      ? 'expired'
                      : 'revoked'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

const TABS = [
  { key: 'invite', label: 'Invite a provider' },
  { key: 'payment', label: 'Record a payment' },
  { key: 'membership', label: 'Medical director payment' },
  { key: 'booking', label: 'Add an appointment' },
] as const

export function Tools({
  unpaid,
  providers,
  serviceMap,
  sharePct,
  invites,
}: {
  unpaid: UnpaidBookingView[]
  providers: ProviderView[]
  serviceMap: Record<string, ServiceOption[]>
  sharePct: number
  invites: InviteView[]
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('invite')

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className={cn(
              'rounded-field border px-3 py-2 text-xs transition-colors',
              tab === t.key
                ? 'border-gold bg-gold/10 text-gold'
                : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-secondary',
            )}
          >
            {t.label}
            {t.key === 'payment' && unpaid.length > 0 && (
              <span className="ml-1.5 text-ink-faint tabular-nums">{unpaid.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="rounded-card border border-line bg-surface p-6">
        {tab === 'invite' && <InviteTool invites={invites} />}
        {tab === 'payment' && <PaymentTool unpaid={unpaid} sharePct={sharePct} />}
        {tab === 'membership' && <MembershipTool providers={providers} />}
        {tab === 'booking' && <BookingTool providers={providers} serviceMap={serviceMap} />}
      </div>
    </div>
  )
}
