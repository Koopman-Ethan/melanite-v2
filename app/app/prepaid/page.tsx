import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { getBookableServices } from '@/lib/db/queries/availability'
import {
  getPendingPrepaidLinks,
  getPrepaidBalances,
  getProviderClients,
} from '@/lib/db/queries/prepaid'

import { BalanceCard, type ClientBalances } from './balance-card'
import { SellBalance } from './sell-balance'

export const metadata: Metadata = { title: 'Prepaid · Melanite' }
export const dynamic = 'force-dynamic'

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const date = (d: Date) =>
  new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Denver',
  })

export default async function PrepaidPage() {
  const user = await requireProvider()

  const [balances, pendingLinks, clients, services] = await Promise.all([
    getPrepaidBalances(user.id),
    getPendingPrepaidLinks(user.id),
    getProviderClients(user.id),
    getBookableServices(user.id),
  ])

  // Grouped by client. Spending crosses balances, so a per-purchase list would make the
  // provider add up rows to answer the only question they actually have.
  const byClient = new Map<string, ClientBalances>()
  for (const b of balances) {
    const existing = byClient.get(b.clientId) ?? {
      clientId: b.clientId,
      clientName: b.clientName ?? b.clientEmail ?? 'Client',
      clientEmail: b.clientEmail,
      spendableCents: 0,
      purchases: [],
    }

    existing.spendableCents +=
      b.status === 'active' ? Math.round(Number(b.remainingAmount) * 100) : 0
    existing.purchases.push({
      id: b.id,
      originalAmount: b.originalAmount,
      remainingAmount: b.remainingAmount,
      purchasedAt: b.purchasedAt,
      status: b.status,
      purchaserName: b.purchaserName,
    })

    byClient.set(b.clientId, existing)
  }

  const grouped = [...byClient.values()].sort((a, b) => b.spendableCents - a.spendableCents)
  const outstandingCents = grouped.reduce((sum, c) => sum + c.spendableCents, 0)

  const bookable = services.map((s) => ({
    providerServiceId: s.providerServiceId,
    name: s.name,
    category: s.category,
    price: s.price,
  }))

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Prepaid</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Money clients have paid up front, spendable on anything they book.{' '}
          {grouped.filter((c) => c.spendableCents > 0).length} with a balance ·{' '}
          {usd(outstandingCents / 100)} still to be used.
        </p>
      </header>

      <section className="space-y-4">
        <SellBalance clients={clients} />
      </section>

      {pendingLinks.length > 0 && (
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
              Awaiting payment
            </h2>
            <p className="mt-1 text-xs text-ink-faint">
              Links you have sent that nobody has paid yet. The balance appears below the moment
              one is.
            </p>
          </div>

          <ul className="space-y-2">
            {pendingLinks.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4"
              >
                <div className="min-w-0">
                  <p className="font-medium">{l.clientName ?? l.clientEmail ?? 'Client'}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {l.purchaserName ? `Being bought by ${l.purchaserName} · ` : ''}
                    {l.expiresAt < new Date()
                      ? `Link expired ${date(l.expiresAt)}. Send a new one.`
                      : `Link expires ${date(l.expiresAt)}`}
                  </p>
                </div>
                <div className="text-right">
                  <div className="tabular-nums font-semibold">{usd(l.amount)}</div>
                  <div className="text-xs text-ink-faint">unpaid</div>
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
            Spent oldest first, so a balance bought last year goes before one bought this month.
          </p>
        </div>

        {grouped.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-10 text-center">
            <p className="text-sm text-ink-muted">Nobody has prepaid yet.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {grouped.map((c) => (
              <BalanceCard key={c.clientId} balances={c} services={bookable} />
            ))}
          </ul>
        )}
      </section>

      {/* The two rules a provider will be asked about, where they will be asked. */}
      <p className="text-xs text-ink-faint">
        Prepaid balances do not expire and are not refundable. Your share is paid out when the
        balance is bought rather than when it is used, so booking against one moves no money —
        except where the balance falls short, and the difference is collected on a card as usual.
      </p>
    </main>
  )
}
