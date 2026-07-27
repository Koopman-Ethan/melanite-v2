import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import {
  getClientPackages,
  getPackageTemplates,
  getPackageableServices,
} from '@/lib/db/queries/packages'

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
  const [templates, balances, offered] = await Promise.all([
    getPackageTemplates(user.id),
    getClientPackages(user.id),
    getPackageableServices(user.id),
  ])

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

                <ul className="mt-4 space-y-1.5">
                  {b.lines.map((l) => {
                    const left = l.qtyTotal - l.qtyUsed
                    return (
                      <li key={l.itemId} className="flex items-center gap-3 text-sm">
                        <span className="min-w-0 flex-1 truncate text-ink-secondary">
                          {l.serviceName}
                        </span>
                        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                          <span
                            className="block h-full rounded-full bg-gold"
                            style={{ width: `${(l.qtyUsed / l.qtyTotal) * 100}%` }}
                          />
                        </span>
                        <span className="w-20 text-right tabular-nums text-ink-faint">
                          {left} of {l.qtyTotal}
                        </span>
                      </li>
                    )
                  })}
                </ul>

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
        Selling a package needs the client checkout flow, which isn&rsquo;t built yet. Booking a
        session against a balance moves no money — the split settled when the client paid.
      </p>
    </main>
  )
}
