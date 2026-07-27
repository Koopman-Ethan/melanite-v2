import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { getAvailableServices, getProviderServices } from '@/lib/db/queries/services'

import { AddService } from './add-service'
import { ServiceRow } from './service-row'

export const metadata: Metadata = { title: 'My services · Melanite' }
export const dynamic = 'force-dynamic'

export default async function ServicesPage() {
  const user = await requireProvider()
  const [mine, available] = await Promise.all([
    getProviderServices(user.id),
    getAvailableServices(user.id),
  ])

  const live = mine.filter((s) => s.isActive && s.offeredPlatformWide)

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My services</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Your price and appointment length for each treatment. {live.length} of {mine.length}{' '}
          {mine.length === 1 ? 'is' : 'are'} bookable.
        </p>
      </header>

      {mine.length === 0 ? (
        <div className="rounded-card border border-dashed border-line p-10 text-center">
          <p className="text-sm text-ink-muted">You don&rsquo;t offer any services yet.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {mine.map((s) => (
            <ServiceRow key={s.id} service={s} />
          ))}
        </ul>
      )}

      <AddService options={available} />

      <p className="text-xs text-ink-faint">
        Duration limits are set by Melanite per treatment; your price is yours. Melanite keeps
        a share of each appointment — see Earnings for the split.
      </p>
    </main>
  )
}
