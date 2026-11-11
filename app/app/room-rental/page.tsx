import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { Notice } from '@/components/ui/field'
import { todayInDenver } from '@/lib/validation'
import {
  getMonthOccupancy,
  getMyRentals,
  getRoomSettings,
  releaseExpiredHolds,
} from '@/lib/db/queries/room-rental'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getMyLease } from '@/lib/db/queries/rooms'
import { providers } from '@/lib/db/schema'
import { clearedForRoom } from '@/lib/rooms/access'
import { getContractState } from '@/lib/rooms/contracts'
import { daysUntil, firstOfNextMonth } from '@/lib/rooms/lease-schedule'

import { ContractUpload } from './contract-upload'
import { RentalShell } from './rental-shell'
import { TenantCard } from './tenant-card'

export const metadata: Metadata = { title: 'Room rental · Melanite' }
export const dynamic = 'force-dynamic'


export default async function RoomRentalPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; paid?: string; cancelled?: string; card?: string }>
}) {
  const user = await requireProvider()
  const params = await searchParams
  const settings = await getRoomSettings()

  const today = todayInDenver()
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : today.slice(0, 7)

  // Swept on read. There is no scheduler in this stack yet, and a hold that only clears when
  // someone looks at the page is still cleared before it can affect them.
  await releaseExpiredHolds()

  const [days, rentals, lease, contract, [card]] = await Promise.all([
    getMonthOccupancy(month, user.id, settings),
    getMyRentals(user.id),
    getMyLease(user.id),
    getContractState(user.id),
    db
      .select({
        paymentMethodId: providers.billingPaymentMethodId,
        brand: providers.billingCardBrand,
        last4: providers.billingCardLast4,
      })
      .from(providers)
      .where(eq(providers.id, user.id))
      .limit(1),
  ])

  const tenant = user.practiceType === 'room_only'

  // When the lease stops, and why. A contract running out is not the same news as notice.
  const leaseEnds = lease ? (lease.endsOn ?? lease.contractEnd) : null
  const leaving = Boolean(lease?.noticeGivenOn)
  const daysLeft = leaseEnds ? daysUntil(leaseEnds, today) : null
  const expiring = !leaving && daysLeft !== null && daysLeft <= 30
  const uploaded = (at: Date) =>
    at.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'America/Denver',
    })

  // A tenant who cannot use the daily room is not shown it at all — their page is their room. A
  // laser provider still sees why it is closed, as before.
  const showDaily = !tenant || (settings.enabled && user.roomRentalEnabled) || rentals.length > 0

  const blocked = !settings.enabled
    ? 'Room rental is not currently available. Melanite will announce it when it opens.'
    : !clearedForRoom(user)
      ? 'Your account is not yet cleared. Melanite will enable it once your required documents are confirmed.'
      : !user.roomRentalEnabled
        ? 'Room rental is not available on your account. Contact Melanite.'
        : null

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Room rental</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {tenant
            ? 'Your space at Melanite, and the card your rent is taken from.'
            : 'Rent the daily room by the day or half day. This is space only — it does not book the laser.'}
        </p>
      </header>

      {params.card === 'saved' && (
        <Notice tone="success">Card saved. It can take a moment to show here.</Notice>
      )}

      {/* Only ever their own lease. Monthly rooms are a contract Keoni sets up, so nobody is shown
          spaces or prices they have not been offered (4 November). */}
      {lease && (
        <section className="space-y-3 rounded-card border border-line p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">{lease.roomName}</h2>
            <span className="text-sm tabular-nums">
              {(lease.monthlyCents / 100).toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD',
              })}{' '}
              / month <span className="text-xs text-ink-faint">plus card processing</span>
            </span>
          </div>
          {lease.status === 'past_due' && (
            <Notice>
              Your last rent payment was declined. Add a working card below — it will be retried
              automatically, and Melanite has been told.
            </Notice>
          )}
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-ink-faint">
                {lease.startsOn > today ? 'Starts' : 'Since'}
              </dt>
              <dd>{lease.startsOn}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-faint">Next rent</dt>
              <dd>
                {leaseEnds && leaseEnds <= firstOfNextMonth(today)
                  ? 'None — your lease ends first'
                  : lease.startsOn > today
                    ? lease.startsOn
                    : firstOfNextMonth(today)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-faint">
                {leaving ? 'Ends (notice given)' : 'Contract ends'}
              </dt>
              <dd>{leaseEnds}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-faint">Deposit</dt>
              <dd>
                {(lease.depositCents / 100).toLocaleString('en-US', {
                  style: 'currency',
                  currency: 'USD',
                })}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-ink-faint">
            Rent comes out on the 1st of each month. To give notice, contact Melanite — 30
            days&rsquo; notice is required.
          </p>
        </section>
      )}

      {(tenant || lease) && (
        <TenantCard
          card={card?.paymentMethodId ? { brand: card.brand, last4: card.last4 } : null}
          waitingForLease={!lease}
        />
      )}

      {/* The signed contract, beside the card: the two things a rental needs from them. Shown
          whoever uploaded it — Keoni can put it on file for them from her Rooms page. */}
      {(tenant || lease) && (
        <section className="space-y-3 rounded-card border border-line p-5">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Signed contract
          </h2>

          {expiring && !contract.waiting && (
            <Notice tone="warning">
              Your contract ends on {leaseEnds}, and your rental ends with it. To stay, upload your
              newly signed contract here and Melanite will renew it.
            </Notice>
          )}

          {contract.current && (
            <p className="text-sm">
              On file — uploaded {uploaded(contract.current.uploadedAt)}
              {contract.current.byTenant ? '' : ' by Melanite'}.{' '}
              <a
                href={`/api/room-contract/${contract.current.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-gold underline underline-offset-4"
              >
                View
              </a>
            </p>
          )}

          {contract.waiting && (
            <p className="text-sm">
              {lease ? 'New contract received' : 'Received'} — uploaded{' '}
              {uploaded(contract.waiting.uploadedAt)}
              {contract.waiting.byTenant ? '' : ' by Melanite'}.{' '}
              <a
                href={`/api/room-contract/${contract.waiting.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-gold underline underline-offset-4"
              >
                View
              </a>
              <span className="mt-1 block text-xs text-ink-faint">
                {lease
                  ? 'Melanite will renew your rental on it.'
                  : 'Melanite will set up your rental and let you know.'}
              </span>
            </p>
          )}

          {!contract.current && !contract.waiting && (
            <p className="text-sm text-ink-muted">
              No contract on file. Upload your signed contract so Melanite can set up your rental.
            </p>
          )}

          <ContractUpload
            providerId={user.id}
            label={
              contract.waiting
                ? 'Upload a different file'
                : contract.current
                  ? 'Upload a renewal contract'
                  : 'Upload signed contract'
            }
          />
          <p className="text-xs text-ink-faint">A PDF or a photo of every signed page, up to 10MB.</p>
        </section>
      )}

      {params.paid === '1' && (
        <Notice tone="success">
          Payment received. Your rental is confirmed as soon as Stripe reports it — refresh in a
          moment if it still shows as awaiting payment.
        </Notice>
      )}
      {params.cancelled === '1' && (
        <Notice tone="warning">
          Checkout cancelled. The block is released — nothing was charged.
        </Notice>
      )}

      {showDaily && (
        <>
          {tenant && (
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
              The daily room
            </h2>
          )}

          {/* Shown rather than redirected. A provider sent away with no explanation learns
              nothing, and two of these three are things only Melanite can change. Past rentals
              stay visible regardless, since a revoked flag must not hide history. */}
          {blocked && <Notice tone="warning">{blocked}</Notice>}

          <RentalShell
            month={month}
            days={days}
            today={today}
            canBook={!blocked}
            rentals={rentals.map((r) => ({
              id: r.id,
              rentalDate: r.rentalDate,
              slotType: r.slotType,
              price: r.price,
              status: r.status,
              startAt: r.startAt.toISOString(),
              hoursOut: r.hoursOut,
            }))}
            fullDayPrice={settings.fullDayPrice}
            halfDayPrice={settings.halfDayPrice}
            amStart={settings.amStart}
            amEnd={settings.amEnd}
            pmEnd={settings.pmEnd}
          />
        </>
      )}
    </main>
  )
}
