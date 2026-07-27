import type { Metadata } from 'next'

import { requireAdmin } from '@/lib/auth/dal'
import {
  getActiveProviders,
  getManualEntries,
  getProviderServiceMap,
  getProviderSharePct,
  getUnpaidBookings,
} from '@/lib/db/queries/admin-tools'

import { Tools } from './tools'

export const metadata: Metadata = { title: 'Tools · Melanite Admin' }
export const dynamic = 'force-dynamic'

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const METHOD_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  cherry: 'Cherry',
  groupon: 'Groupon',
  cash: 'Cash',
  check: 'Check',
  other: 'Other',
}

const SOURCE_LABELS: Record<string, string> = {
  booking: 'Booking',
  package: 'Package',
  room_rental: 'Room rental',
  membership: 'Medical director',
  training: 'Training',
}

export default async function AdminToolsPage() {
  await requireAdmin()

  const [unpaid, providers, serviceMap, sharePct, manualEntries] = await Promise.all([
    getUnpaidBookings(),
    getActiveProviders(),
    getProviderServiceMap(),
    getProviderSharePct(),
    getManualEntries(),
  ])

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Tools</h1>
        <p className="mt-1 text-sm text-ink-muted">
          For the money and appointments that never went through the app.
        </p>
      </header>

      <Tools
        unpaid={unpaid.map((b) => ({ ...b, startTime: b.startTime.toISOString() }))}
        providers={providers}
        serviceMap={serviceMap}
        sharePct={sharePct}
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          Recorded by hand
        </h2>
        {manualEntries.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-8 text-center text-sm text-ink-muted">
            Nothing has been entered manually yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-muted">
                <tr className="border-b border-line">
                  <th className="p-3 text-left font-medium">Date</th>
                  <th className="p-3 text-left font-medium">Source</th>
                  <th className="p-3 text-left font-medium">Method</th>
                  <th className="p-3 text-left font-medium">Provider</th>
                  <th className="p-3 text-right font-medium">Gross</th>
                  <th className="p-3 text-right font-medium">Platform</th>
                  <th className="p-3 text-left font-medium">Entered by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {manualEntries.map((e) => (
                  <tr key={e.id}>
                    <td className="p-3 whitespace-nowrap tabular-nums">
                      {e.createdAt.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        timeZone: 'America/Denver',
                      })}
                    </td>
                    <td className="p-3">{SOURCE_LABELS[e.source] ?? e.source}</td>
                    <td className="p-3 text-ink-muted">
                      {METHOD_LABELS[e.paymentMethod] ?? e.paymentMethod}
                      {e.externalReference && (
                        <span className="ml-1.5 text-xs text-ink-faint">
                          {e.externalReference}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-ink-muted">{e.providerName ?? '—'}</td>
                    <td className="p-3 text-right tabular-nums">{usd(e.grossAmount)}</td>
                    <td className="p-3 text-right tabular-nums font-medium">
                      {usd(e.melaniteCut)}
                    </td>
                    <td className="p-3 text-xs text-ink-faint">{e.recordedByName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* The point of `recordedBy`: a hand-entered figure is always attributable to a person,
            and this is where that becomes visible rather than merely stored. */}
        <p className="text-xs text-ink-faint">
          Every row here was typed by someone. Machine-generated entries — Stripe payments,
          refunds, subscription invoices — are excluded by design.
        </p>
      </section>
    </main>
  )
}
