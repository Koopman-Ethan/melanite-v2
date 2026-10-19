import '../envConfig'

import { and, eq } from 'drizzle-orm'

import { bookings, providerServices, providers, services } from '@/lib/db/schema'
import { CLOSEOUT_GRACE_HOURS } from '@/lib/end-of-use'
import { feeForProviderService, feeForService } from '@/lib/rental/schedule'

import { describeDatabase, requireEnv } from '../lib/env-guard'
import { db } from './db'

// A rental appointment that has already happened, so the no-show path can be tested.
//
//   npm run dev:past-booking
//   npm run dev:past-booking -- --email nichole.mim@gmail.com --service "Laser Hair Removal — Bikini" --hours-ago 2
//
// WHY THIS EXISTS
//
// "Completed" and "No-show" only appear once an appointment's start time has passed — marking a
// future one is always a mistake, and `markNoShow` refuses it server-side. So testing the refund
// means waiting for a booking to age, which nobody is going to do.
//
// IT LEAVES THE FEE UNPAID, which is the whole point since 12 October.
//
// Rent is no longer taken at booking; it is swept twelve hours after the session ends, by
// `lib/rental/settle.ts`. A seeded past booking with no ledger row is exactly the state the
// sweep exists to find, and `--hours-ago` puts a session on either side of the grace period:
//
//   --hours-ago 2     inside the window, so the sweep must IGNORE it
//   --hours-ago 20    past due, so the sweep must CHARGE it
//
// It used to charge inline, because what was being tested was the refund on a no-show. Neither
// half of that is true any more: nothing refunds automatically, and nothing charges at booking.
//
// The booking is left `upcoming` deliberately. That is the real state of an appointment nobody
// has closed out: the hour has passed and the provider has not said what happened.
//
// NEVER IN PRODUCTION. Guarded by `requireEnv` — this charges somebody's card for an
// appointment that did not happen.

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

async function main() {
  requireEnv(['dev'], 'seed a past appointment')

  const email = (arg('email') ?? process.env.E2E_PROVIDER_EMAIL ?? '').trim().toLowerCase()
  const serviceName = arg('service') ?? 'Laser Hair Removal — Bikini'
  const hoursAgo = Number(arg('hours-ago') ?? 2)

  if (!email) {
    console.error('Pass --email, or set E2E_PROVIDER_EMAIL.')
    process.exitCode = 1
    return
  }
  if (!Number.isFinite(hoursAgo) || hoursAgo <= 0) {
    console.error('--hours-ago has to be a positive number.')
    process.exitCode = 1
    return
  }

  console.log(`${describeDatabase()}\n`)

  const [provider] = await db
    .select({
      id: providers.id,
      firstName: providers.firstName,
      lastName: providers.lastName,
      cardLast4: providers.billingCardLast4,
      paymentMethodId: providers.billingPaymentMethodId,
      rentBasis: providers.rentBasis,
    })
    .from(providers)
    .where(eq(providers.email, email))
    .limit(1)

  if (!provider) {
    console.error(`No provider with the email ${email}.`)
    process.exitCode = 1
    return
  }
  if (!provider.paymentMethodId) {
    console.error(
      `${provider.firstName} has no card on file, so nothing can be charged and there would be\n` +
        'nothing to refund. Run `npm run dev:rental-ready` first.',
    )
    process.exitCode = 1
    return
  }

  const [service] = await db
    .select({
      id: services.id,
      name: services.name,
      suggested: services.suggestedDurationMins,
    })
    .from(services)
    .where(eq(services.name, serviceName))
    .limit(1)

  if (!service) {
    console.error(`"${serviceName}" is not in the catalogue.`)
    process.exitCode = 1
    return
  }

  const fee = await feeForService(service.name)
  if (fee === null) {
    console.error(`"${service.name}" has no rental fee, so it cannot be booked.`)
    process.exitCode = 1
    return
  }

  // The provider_service row, the same way `createBooking` does it — created on demand and
  // carrying this provider's remembered length.
  const [existing] = await db
    .select({ id: providerServices.id, durationMins: providerServices.durationMins })
    .from(providerServices)
    .where(
      and(
        eq(providerServices.providerId, provider.id),
        eq(providerServices.serviceId, service.id),
      ),
    )
    .limit(1)

  const durationMins = existing?.durationMins ?? service.suggested

  const providerServiceId =
    existing?.id ??
    (
      await db
        .insert(providerServices)
        .values({
          providerId: provider.id,
          serviceId: service.id,
          price: '0.00',
          durationMins,
          isActive: true,
        })
        .returning({ id: providerServices.id })
    )[0].id

  // The laser is one shared resource behind an exclusion constraint and dev carries real
  // appointments, so walk further back until a slot is free rather than failing on whoever was
  // booked at the hour we happened to pick.
  let bookingId: string | null = null
  for (let back = hoursAgo; back < hoursAgo + 72; back += 1) {
    const start = new Date(Date.now() - back * 60 * 60 * 1000)
    const end = new Date(start.getTime() + durationMins * 60_000)

    try {
      const rows = await db
        .insert(bookings)
        .values({
          providerId: provider.id,
          providerServiceId,
          treatmentArea: 'Seeded for no-show testing',
          notes: 'Seeded by dev:past-booking — mark this as a no-show.',
          originalPrice: '0.00',
          price: '0.00',
          paymentSource: 'rental',
          durationMins,
          startTime: start,
          endTime: end,
          status: 'upcoming',
        })
        .returning({ id: bookings.id })

      bookingId = rows[0].id
      console.log(
        `  booked   ${service.name} for ${provider.firstName} ${provider.lastName}\n` +
          `           ${start.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })} Denver, ${durationMins} min, left as upcoming`,
      )
      break
    } catch (err) {
      const e = err as { cause?: { code?: string }; code?: string }
      if ((e.code ?? e.cause?.code) !== '23P01') throw err
    }
  }

  if (!bookingId) {
    console.error('Could not find a free past slot in the last three days.')
    process.exitCode = 1
    return
  }

  const dueIn = hoursAgo - CLOSEOUT_GRACE_HOURS

  // WHAT WILL ACTUALLY BE CHARGED, which since 14 October is not always the schedule fee. A
  // provider on `half_own_price` pays half of their own price for the service, and is never
  // swept at all — so printing the tier fee and "the sweep will take it" would describe a
  // different booking from the one just made, to the person using this script to test exactly
  // that difference.
  const ownsTheFigure = provider.rentBasis === 'half_own_price'
  const actual = ownsTheFigure
    ? await feeForProviderService(provider.id, service.name)
    : fee

  console.log(
    actual === null
      ? `  unpriced they have no price for ${service.name}, so there is nothing to halve - Keoni types the figure`
      : `  unpaid   $${(actual / 100).toFixed(2)} owed, nothing charged yet (card ends ${provider.cardLast4})`,
  )

  if (ownsTheFigure) {
    console.log(
      `  review   never swept - half of their own price, so it waits for Keoni to confirm it`,
    )
    console.log('')
    console.log('To price it and charge it:')
    console.log('  /app/admin/queue -> "Awaiting your figure"')
  } else {
    console.log(
      dueIn >= 0
        ? `  due      ${dueIn}h past the ${CLOSEOUT_GRACE_HOURS}h grace - the sweep will take it`
        : `  not due  ${-dueIn}h of the ${CLOSEOUT_GRACE_HOURS}h grace left - the sweep must skip it`,
    )
    console.log('')
    console.log('To take it now rather than waiting for the sweep:')
    console.log('  /app/admin/revenue -> "Settle rent now"')
  }
  console.log('')
  console.log('Or open Appointments as that provider: "Completed" and "No-show" are both')
  console.log('there, because the hour has passed. A no-show ASKS WHAT HAPPENED and is never')
  console.log('swept - it goes to /app/admin/queue for Keoni to decide whether rent is owed.')
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
