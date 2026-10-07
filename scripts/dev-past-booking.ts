import '../envConfig'

import { and, eq } from 'drizzle-orm'

import { bookings, providerServices, providers, services } from '@/lib/db/schema'
import { chargeRentalFee } from '@/lib/rental/charge'
import { feeForService } from '@/lib/rental/schedule'

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
// IT MAKES A REAL CHARGE. The whole point is the refund, and `refundRentalFee` refunds an actual
// Stripe PaymentIntent — a hand-written ledger row with an invented intent id would fail at
// Stripe with "No such payment_intent", which is a worse lie than not seeding at all. So this
// goes through `chargeRentalFee`, the same function the booking path calls.
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

  // A real charge, so there is a real payment to refund.
  const charged = await chargeRentalFee(bookingId)

  if ('error' in charged) {
    console.error(`  FAILED   the rental fee did not go through: ${charged.error}`)
    process.exitCode = 1
    return
  }
  if ('skipped' in charged) {
    console.log(`  skipped  ${charged.skipped}`)
    return
  }

  console.log(
    `  charged  $${(charged.charged.amountCents / 100).toFixed(2)} to the card ending ${provider.cardLast4}\n`,
  )
  console.log('Now open Appointments as that provider. "Completed" and "No-show" are both there,')
  console.log('because the hour has passed. No-show refunds the fee; Charges nets to zero.')
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
