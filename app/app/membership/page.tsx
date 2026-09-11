import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import { GROWTH_HUB, MEDICAL_DIRECTOR, MEMBERSHIP_STATUS } from '@/lib/product-names'
import { getEpicutis, getMembership, getMembershipCharges } from '@/lib/db/queries/membership'

import { Epicutis } from './epicutis'
import { DirectorForm } from './director-form'
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
  ...MEMBERSHIP_STATUS,
  // Wording this card owns. Both mean somebody cannot book, which is not a state the optional
  // membership has an equivalent of.
  inactive: { label: 'Inactive', className: 'border-danger/40 bg-danger/10 text-danger' },
  none: { label: 'Not set up', className: 'border-line-strong bg-overlay text-ink-faint' },
} as const

export default async function MembershipPage() {
  const user = await requireProvider()
  const [membership, charges, epicutis] = await Promise.all([
    getMembership(user.id),
    getMembershipCharges(user.id),
    getEpicutis(user.id),
  ])

  const status = STATUS[membership.status]
  const blocksBooking = membership.status !== 'active'

  // "Not set up" is true of a provider who has done nothing and false of one who has filed her
  // director and is waiting on Melanite. Telling the second she is not set up reads as her
  // submission having gone nowhere, which is the moment people email asking if it worked.
  const awaitingReview =
    membership.type === 'own' && membership.director !== null && membership.status === 'none'
  const statusLabel = awaitingReview ? 'With Melanite' : status.label

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">My memberships</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What you pay Melanite each month, and what each one gets you.
        </p>
      </header>

      {/* Same shape as the growth hub card below, with one deliberate difference: this one
          takes a warning tint when it is not active. The two memberships look alike because
          they are billed alike, but only this one decides whether somebody can work. */}
      <section
        className={cn(
          'rounded-card border p-6',
          blocksBooking ? 'border-warning/40 bg-warning/10' : 'border-line bg-surface',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{MEDICAL_DIRECTOR}</h2>
            <p className="mt-1 text-sm text-ink-muted">
              {/* Required, and the price depends on whose director it is. Said here rather
                  than in the page header now that the header covers both memberships. */}
              Required to book laser time. $150 / month from Melanite, or bring your own.
            </p>
          </div>

          <span
            className={cn(
              'rounded-field border px-2.5 py-1 text-xs',
              status.className,
            )}
          >
            {statusLabel}
          </span>
        </div>

        <div className="mt-4">
          <div>
            {membership.type && (
              <p className="text-sm text-ink-muted">
                {membership.type === 'melanite' ? 'Melanite plan' : 'Your own director'}
              </p>
            )}

            {/* The consequence, stated plainly. This status is the booking gate, and a provider
                seeing "past due" should not have to work out what that costs them. */}
            <p className="mt-2 text-sm text-ink-secondary">
              {awaitingReview
                ? 'Your director’s details are with Melanite. They’ll confirm the arrangement and open your booking.'
                : blocksBooking
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
        </div>

        {/* Below the detail and left-aligned, the same place the growth hub puts its button.
            Two cards billed the same way should not put their one control in two places. */}
        <div className="mt-5">
          <MembershipActions
            type={membership.type}
            status={membership.status}
            planConfigured={membership.planConfigured}
            hasStripeSubscription={membership.hasStripeSubscription}
          />
        </div>
      </section>

      {membership.type === 'own' && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Your medical director
          </h2>

          {/* Rendered whether or not details exist. The previous version required
              `membership.director` here as well, so a provider on the own-director path with
              nothing on file saw no details AND no form — and `MembershipActions` returns null
              for her too, leaving the page with nothing on it to do. Meanwhile the booking gate
              was linking her here saying "Set up your medical director". */}
          {!membership.director && (
            <div className="rounded-card border border-line bg-surface p-5">
              <p className="text-sm text-ink-secondary">
                You told us you bring your own medical director. Add their details here so Melanite
                can confirm the arrangement and open your booking.
              </p>
              <DirectorForm existing={null} status={membership.status} />
            </div>
          )}

          {membership.director && (
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

              {/* Editable by the provider. It used to say "contact Melanite", which was the
                  honest description of a form that did not exist rather than a policy — and it
                  put a licence expiry date, which lapses, behind an email to somebody else. */}
              <DirectorForm
                existing={{
                  name: membership.director.name,
                  credentials: membership.director.credentials,
                  npi: membership.director.npi,
                  licenseNumber: membership.director.licenseNumber,
                  licenseState: membership.director.licenseState,
                  licenseExpiry: membership.director.licenseExpiry,
                  contactEmail: membership.director.contactEmail,
                  contactPhone: membership.director.contactPhone,
                }}
                status={membership.status}
              />

              <p className="mt-4 text-xs text-ink-faint">
                Changing who supervises you also needs a new signed supervision agreement with
                Melanite. Updating the details here tells them, it does not replace that.
              </p>
            </div>
          )}
        </section>
      )}

      <Epicutis
        epicutis={{
          status: epicutis.status,
          renewalDate: epicutis.renewalDate?.toISOString() ?? null,
          cancelAtPeriodEnd: epicutis.cancelAtPeriodEnd,
          configured: epicutis.configured,
        }}
      />

      {charges.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Billing history
          </h2>
          <div
              tabIndex={0}
              role="region"
              aria-label="Scrollable table"
              className="overflow-x-auto rounded-card border border-line"
            >
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
                      {c.entryType === 'refund'
                        ? 'Refund'
                        : c.plan === 'epicutis'
                          ? `${GROWTH_HUB} — monthly`
                          : `${MEDICAL_DIRECTOR} — monthly`}
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
