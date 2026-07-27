import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import { getMembership, getMembershipCharges } from '@/lib/db/queries/membership'

import { MembershipActions } from './membership-actions'

export const metadata: Metadata = { title: 'Membership · Melanite' }
export const dynamic = 'force-dynamic'

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const date = (d: Date | string | null) =>
  d
    ? new Date(d).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/Denver',
      })
    : null

const STATUS = {
  active: { label: 'Active', className: 'border-success/40 bg-success/10 text-success' },
  past_due: { label: 'Past due', className: 'border-warning/40 bg-warning/10 text-warning' },
  inactive: { label: 'Inactive', className: 'border-danger/40 bg-danger/10 text-danger' },
  none: { label: 'Not set up', className: 'border-line-strong bg-overlay text-ink-faint' },
} as const

export default async function MembershipPage() {
  const user = await requireProvider()
  const [membership, charges] = await Promise.all([
    getMembership(user.id),
    getMembershipCharges(user.id),
  ])

  const status = STATUS[membership.status]
  const blocksBooking = membership.status !== 'active'

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Medical director</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Idaho requires medical direction for these treatments. Melanite can supply one, or you
          can bring your own.
        </p>
      </header>

      <section
        className={cn(
          'rounded-card border p-6',
          blocksBooking ? 'border-warning/40 bg-warning/10' : 'border-line bg-surface',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px] uppercase tracking-wide',
                  status.className,
                )}
              >
                {status.label}
              </span>
              {membership.type && (
                <span className="text-sm text-ink-muted">
                  {membership.type === 'melanite' ? 'Melanite plan' : 'Your own director'}
                </span>
              )}
            </div>

            {/* The consequence, stated first. This status is the booking gate, and a provider
                seeing "past due" should not have to work out what that costs them. */}
            <p className="mt-3 text-sm text-ink-secondary">
              {blocksBooking
                ? 'You can’t book laser time until this is active.'
                : 'You’re covered — laser booking is open.'}
            </p>

            {membership.type === 'melanite' && membership.renewalDate && (
              <p className="mt-1 text-sm text-ink-muted">
                {membership.cancelAtPeriodEnd
                  ? `Cancels on ${date(membership.renewalDate)}. You keep access until then.`
                  : `Renews ${date(membership.renewalDate)} · $150/month`}
              </p>
            )}

            {membership.type === 'melanite' && membership.startDate && (
              <p className="mt-0.5 text-xs text-ink-faint">
                Started {date(membership.startDate)}
              </p>
            )}
          </div>

          <MembershipActions
            type={membership.type}
            status={membership.status}
            planConfigured={membership.planConfigured}
            hasStripeSubscription={membership.hasStripeSubscription}
          />
        </div>
      </section>

      {membership.type === 'own' && membership.director && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Your medical director
          </h2>
          <div className="rounded-card border border-line bg-surface p-5">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-faint">Name</dt>
                <dd className="mt-0.5">
                  {membership.director.name}
                  {membership.director.credentials && (
                    <span className="text-ink-muted">, {membership.director.credentials}</span>
                  )}
                </dd>
              </div>
              {membership.director.npi && (
                <div>
                  <dt className="text-xs text-ink-faint">NPI</dt>
                  <dd className="mt-0.5 tabular-nums">{membership.director.npi}</dd>
                </div>
              )}
              {membership.director.licenseNumber && (
                <div>
                  <dt className="text-xs text-ink-faint">License</dt>
                  <dd className="mt-0.5 tabular-nums">
                    {membership.director.licenseNumber}
                    {membership.director.licenseState && ` (${membership.director.licenseState})`}
                  </dd>
                </div>
              )}
              {membership.director.licenseExpiry && (
                <div>
                  <dt className="text-xs text-ink-faint">License expires</dt>
                  <dd className="mt-0.5">{date(membership.director.licenseExpiry)}</dd>
                </div>
              )}
              {membership.director.contactEmail && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-ink-faint">Contact</dt>
                  <dd className="mt-0.5">
                    {[membership.director.contactEmail, membership.director.contactPhone]
                      .filter(Boolean)
                      .join(' · ')}
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-4 text-xs text-ink-faint">
              To change any of this, contact Melanite — a new supervision agreement has to be
              signed and filed.
            </p>
          </div>
        </section>
      )}

      {charges.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Billing history
          </h2>
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-muted">
                <tr className="border-b border-line">
                  <th className="p-3 text-left font-medium">Date</th>
                  <th className="p-3 text-left font-medium">Description</th>
                  <th className="p-3 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {charges.map((c) => (
                  <tr key={c.id} className={c.entryType === 'refund' ? 'opacity-70' : undefined}>
                    <td className="p-3 whitespace-nowrap tabular-nums">{date(c.createdAt)}</td>
                    <td className="p-3 text-ink-muted">
                      {c.entryType === 'refund' ? 'Refund' : 'Medical director — monthly'}
                    </td>
                    <td className="p-3 text-right tabular-nums">{usd(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Worth noting because v1 genuinely could not do this. */}
          <p className="text-xs text-ink-faint">
            Melanite&rsquo;s old portal had no record of these charges — they existed only in
            Stripe.
          </p>
        </section>
      )}
    </main>
  )
}
