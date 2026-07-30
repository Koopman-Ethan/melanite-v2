import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import { getBookableServices } from '@/lib/db/queries/availability'
import {
  getClientPackages,
  getOutstandingPackageLinks,
  getPackageTemplates,
  getPackageableServices,
} from '@/lib/db/queries/packages'

import { BalanceLines } from './balance-lines'
import { TemplateList } from './template-list'

export const metadata: Metadata = { title: 'Packages · Melanite' }
export const dynamic = 'force-dynamic'

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const date = (d: Date | null) =>
  d
    ? new Date(d).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/Denver',
      })
    : null

const STATUS = {
  active: 'border-success/40 bg-success/10 text-success',
  exhausted: 'border-line-strong bg-overlay text-ink-faint',
  expired: 'border-warning/40 bg-warning/10 text-warning',
  refunded: 'border-danger/40 bg-danger/10 text-danger',
} as const

export default async function PackagesPage() {
  const user = await requireProvider()
  const [templates, balances, offered, pendingLinks, bookableServices] = await Promise.all([
    getPackageTemplates(user.id),
    getClientPackages(user.id),
    getPackageableServices(user.id),
    getOutstandingPackageLinks(user.id),
    getBookableServices(user.id),
  ])

  // A package line stores a service, but booking needs the provider's own offering of it —
  // that is where the duration and the price live. Built once rather than per line.
  const bookable = new Map(bookableServices.map((s) => [s.serviceId, s.providerServiceId]))

  const live = balances.filter((b) => b.status === 'active' && !b.expiredByDate)
  const outstanding = live.reduce((s, b) => s + Number(b.remainingValue), 0)

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Packages</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Prepaid session bundles you sell. {live.length} active ·{' '}
          {usd(outstanding)} of sessions still owed.
        </p>
      </header>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Packages you offer
          </h2>
          <p className="mt-1 text-xs text-ink-faint">
            Line items must add up to the total exactly, to the cent.
          </p>
        </div>
        <TemplateList templates={templates} services={offered} />
      </section>

      {pendingLinks.length > 0 && (
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
              Awaiting payment
            </h2>
            <p className="mt-1 text-xs text-ink-faint">
              Links you have sent that nobody has paid yet. The package appears under client
              balances the moment it is.
            </p>
          </div>

          <ul className="space-y-2">
            {pendingLinks.map((l) => (
              <li
                key={l.id}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-3 rounded-card border p-4',
                  l.cherryStartedAt
                    ? 'border-gold/40 bg-gold/5'
                    : 'border-line bg-surface',
                )}
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {l.clientName ?? l.clientEmail ?? 'Client'}{' '}
                    <span className="font-normal text-ink-muted">· {l.templateName}</span>
                  </p>
                  {/* Cherry pays Melanite, not the provider — so their own Stripe account will
                      never show this and nothing else in the app would mention it. */}
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {l.cherryStartedAt
                      ? `Applied through Cherry on ${date(l.cherryStartedAt)} — Melanite collects this one and pays you your half.`
                      : l.expired
                        ? `Link expired ${date(l.expiresAt)}. Send a new one.`
                        : `Link expires ${date(l.expiresAt)}`}
                  </p>
                </div>
                <div className="text-right">
                  <div className="tabular-nums font-semibold">{usd(l.price)}</div>
                  <div
                    className={cn(
                      'text-xs',
                      l.cherryStartedAt ? 'text-gold' : l.expired ? 'text-warning' : 'text-ink-faint',
                    )}
                  >
                    {l.cherryStartedAt ? 'Cherry' : l.expired ? 'expired' : 'unpaid'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Client balances
          </h2>
          <p className="mt-1 text-xs text-ink-faint">
            Sessions clients have paid for and not yet used.
          </p>
        </div>

        {balances.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-10 text-center">
            <p className="text-sm text-ink-muted">No packages sold yet.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {balances.map((b) => (
              <li key={b.id} className="rounded-card border border-line bg-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{b.clientName ?? b.clientEmail ?? 'Client'}</h3>
                      <span
                        className={cn(
                          'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                          b.expiredByDate ? STATUS.expired : STATUS[b.status],
                        )}
                      >
                        {b.expiredByDate ? 'expired' : b.status}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-muted">{b.templateName}</p>
                    {b.clientEmail && b.clientName && (
                      <p className="text-xs text-ink-faint">{b.clientEmail}</p>
                    )}
                  </div>

                  <div className="text-right">
                    <div className="text-lg font-semibold tabular-nums">
                      {b.sessionsRemaining} / {b.sessionsTotal}
                    </div>
                    <div className="text-xs text-ink-faint">
                      sessions left · {usd(b.remainingValue)}
                    </div>
                  </div>
                </div>

                {/* A line the provider no longer offers gets no provider_service_id, and the
                    form says so rather than offering a button that can only fail. The client
                    has already paid for that session either way. */}
                <BalanceLines
                  clientPackageId={b.id}
                  clientName={b.clientName ?? b.clientEmail ?? 'Client'}
                  expired={b.expiredByDate || b.status !== 'active'}
                  lines={b.lines.map((l) => ({
                    ...l,
                    providerServiceId: bookable.get(l.serviceId) ?? null,
                  }))}
                />

                {/* v1 only flipped a package to expired when someone tried to redeem it, so a
                    list could show one as active that was not. Computed on read here. */}
                {b.expiredByDate && (
                  <p className="mt-3 text-xs text-warning">
                    Expired {date(b.expiresAt)} with {b.sessionsRemaining} unused. Contact
                    Melanite if this needs extending.
                  </p>
                )}
                {b.expiresAt && !b.expiredByDate && b.status === 'active' && (
                  <p className="mt-3 text-xs text-ink-faint">Expires {date(b.expiresAt)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-ink-faint">
        Booking a session against a balance moves no money — the split settled when the client
        paid, so a redemption is an entitlement being used rather than a transaction.
      </p>
    </main>
  )
}
