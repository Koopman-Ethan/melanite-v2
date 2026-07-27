import type { Metadata } from 'next'

import { requireAdmin } from '@/lib/auth/dal'
import { getRoster } from '@/lib/db/queries/providers-admin'

import { Roster } from './roster'

export const metadata: Metadata = { title: 'Providers · Melanite Admin' }
export const dynamic = 'force-dynamic'

export default async function AdminProvidersPage() {
  await requireAdmin()
  const roster = await getRoster()

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Providers</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Who may take clients, and who may rent the room. Onboarding ends by telling a provider
          Melanite will enable booking once their documents are confirmed — this is where that
          happens.
        </p>
      </header>

      <Roster rows={roster.rows} roomRentalGloballyOn={roster.roomRentalGloballyOn} />
    </main>
  )
}
