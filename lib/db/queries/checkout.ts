import 'server-only'

import { eq } from 'drizzle-orm'

import { clientLabel } from '@/lib/booking-labels'
import { db } from '@/lib/db'
import { notHouse } from '@/lib/revenue-model'
import {
  bookings,
  checkoutLinks,
  clients,
  platformSettings,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'

// Public checkout. Everything here is reachable by anyone holding a link token, so it returns
// exactly what the payment page needs to display and nothing else — no provider email, no
// Stripe account id, no other appointments. v1's GET /pay/{token} returned whole rows.

export interface CheckoutSettings {
  cardPolicyVersion: string
  cherryApplyUrl: string | null
  lateCancellationHours: number
  cancellationFeeAmount: string
  noShowFeePctOfPrice: string
}

export async function getCheckoutSettings(): Promise<CheckoutSettings> {
  const [row] = await db
    .select({
      cardPolicyVersion: platformSettings.cardPolicyVersion,
      cherryApplyUrl: platformSettings.cherryApplyUrl,
      lateCancellationHours: platformSettings.lateCancellationHours,
      cancellationFeeAmount: platformSettings.cancellationFeeAmount,
      noShowFeePctOfPrice: platformSettings.noShowFeePctOfPrice,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return (
    row ?? {
      cardPolicyVersion: '2026-07-27.v1',
      cherryApplyUrl: null,
      lateCancellationHours: 24,
      cancellationFeeAmount: '50.00',
      noShowFeePctOfPrice: '0.500',
    }
  )
}

export type LinkState = 'payable' | 'paid' | 'expired' | 'cancelled' | 'not_found' | 'unpayable'

export interface BookingCheckout {
  state: LinkState
  linkId: string
  bookingId: string
  clientName: string
  clientEmail: string | null
  treatmentArea: string | null
  serviceName: string
  providerName: string
  providerCredentials: string | null
  startTime: Date
  durationMins: number
  price: string
  originalPrice: string
  discountType: string
  discountValue: string
  tipAmount: string
  paidAt: Date | null
  expiresAt: Date
  cardLast4: string | null
  cardBrand: string | null
}

/** Everything the booking payment page shows, by token.
 *
 *  Expiry is evaluated on read rather than stored-and-trusted. v1 wrote the status back to the
 *  row during a GET; that turns a page view into a write and means a link's state depends on
 *  whether anyone happened to look at it. The row is left alone and the comparison is made
 *  here.
 */
export async function getBookingCheckout(token: string): Promise<BookingCheckout | null> {
  const [row] = await db
    .select({
      linkId: checkoutLinks.id,
      status: checkoutLinks.status,
      tipAmount: checkoutLinks.tipAmount,
      paidAt: checkoutLinks.paidAt,
      expiresAt: checkoutLinks.expiresAt,
      bookingId: bookings.id,
      bookingStatus: bookings.status,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
      treatmentArea: bookings.treatmentArea,
      startTime: bookings.startTime,
      durationMins: bookings.durationMins,
      price: bookings.price,
      originalPrice: bookings.originalPrice,
      discountType: bookings.discountType,
      discountValue: bookings.discountValue,
      serviceName: services.name,
      providerFirst: providers.firstName,
      providerLast: providers.lastName,
      providerCredentials: providers.credentials,
      providerStripeAccount: providers.stripeAccountId,
      providerRevenueModel: providers.revenueModel,
      cardLast4: clients.cardLast4,
      cardBrand: clients.cardBrand,
    })
    .from(checkoutLinks)
    .innerJoin(bookings, eq(checkoutLinks.bookingId, bookings.id))
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .leftJoin(clients, eq(bookings.clientId, clients.id))
    .where(eq(checkoutLinks.token, token))
    .limit(1)

  if (!row) return null

  const state: LinkState =
    row.status === 'paid'
      ? 'paid'
      : row.status === 'cancelled'
        ? 'cancelled'
        : row.expiresAt < new Date()
          ? 'expired'
          : // Cancelled and no-show cannot be paid HERE: nothing was delivered, and a no-show is
            // settled through the fee path rather than the service price. Completed emphatically
            // can — the treatment happened, which is exactly when the money is owed.
            //
            // This used to refuse anything that was not `upcoming`, on the reasoning that paying
            // for an appointment already past "would take money for nothing". True of a
            // cancellation and precisely backwards for a completed one: a provider who pressed
            // Completed before her client paid locked that client out of paying at all, by link
            // and by the emailed link alike, and the page told them to contact their provider —
            // who had just caused it. One real $70 treatment sat unpaid that way.
            //
            // A house appointment is Melanite's own: the charge stays on the platform account,
            // so there is no Connect account to be missing and nothing to check.
            //
            // `notHouse`, NOT `sharesRevenue`. A checkout link is an old-model artefact and is
            // settled the old way whatever its provider is on NOW — so a provider who has moved
            // to rent still has to be payable through Connect for one of these. Production has
            // eleven pending links and ten of them belong to providers moving to rent, so this
            // is a live distinction rather than a hypothetical one.
            row.bookingStatus === 'cancelled' ||
            row.bookingStatus === 'no_show' ||
            (notHouse(row.providerRevenueModel) && !row.providerStripeAccount)
            ? 'unpayable'
            : 'payable'

  return {
    state,
    linkId: row.linkId,
    bookingId: row.bookingId,
    clientName: clientLabel(row.clientName),
    clientEmail: row.clientEmail,
    treatmentArea: row.treatmentArea,
    serviceName: row.serviceName,
    providerName: `${row.providerFirst} ${row.providerLast}`,
    providerCredentials: row.providerCredentials,
    startTime: row.startTime,
    durationMins: row.durationMins,
    price: row.price,
    originalPrice: row.originalPrice,
    discountType: row.discountType,
    discountValue: row.discountValue,
    tipAmount: row.tipAmount,
    paidAt: row.paidAt,
    expiresAt: row.expiresAt,
    cardLast4: row.cardLast4,
    cardBrand: row.cardBrand,
  }
}

/** The client's card on file, for the fee-charging path.
 *
 *  Returns the consent timestamp alongside the card rather than filtering on it, so the caller
 *  can tell "no card" from "card, but nobody agreed to it being used" — those need different
 *  messages, and only one of them is fixable by asking the client again. */
export async function getClientCard(clientId: string) {
  const [row] = await db
    .select({
      id: clients.id,
      stripeCustomerId: clients.stripeCustomerId,
      defaultPaymentMethodId: clients.defaultPaymentMethodId,
      paymentMethodType: clients.paymentMethodType,
      cardBrand: clients.cardBrand,
      cardLast4: clients.cardLast4,
      consentAt: clients.cardOnFileConsentAt,
      consentVersion: clients.cardOnFileConsentVersion,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1)

  return row ?? null
}
