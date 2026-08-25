import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  checkoutLinks,
  clients,
  packageCheckoutLinks,
  packageTemplateItems,
  packageTemplates,
  platformSettings,
  providerServices,
  providers,
  services,
  prepaidCheckoutLinks,
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
          : // A link can be live while the appointment behind it is not — cancelled from the
            // provider's side, or already past. Paying then would take money for nothing.
            // A house appointment is Melanite's own: the charge stays on the platform
            // account, so there is no Connect account to be missing and nothing to check.
            row.bookingStatus !== 'upcoming' ||
              (row.providerRevenueModel !== 'house' && !row.providerStripeAccount)
            ? 'unpayable'
            : 'payable'

  return {
    state,
    linkId: row.linkId,
    bookingId: row.bookingId,
    clientName: row.clientName,
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

export interface PackageCheckoutItem {
  serviceName: string
  quantity: number
  perSessionValue: string
}

export interface PackageCheckout {
  state: LinkState
  linkId: string
  templateName: string
  templateId: string
  providerName: string
  providerCredentials: string | null
  clientName: string | null
  clientEmail: string | null
  price: string
  expiresAfterDays: number | null
  paidAt: Date | null
  expiresAt: Date
  items: PackageCheckoutItem[]
}

export async function getPackageCheckout(token: string): Promise<PackageCheckout | null> {
  const [row] = await db
    .select({
      linkId: packageCheckoutLinks.id,
      status: packageCheckoutLinks.status,
      price: packageCheckoutLinks.price,
      clientName: packageCheckoutLinks.clientName,
      clientEmail: packageCheckoutLinks.clientEmail,
      paidAt: packageCheckoutLinks.paidAt,
      expiresAt: packageCheckoutLinks.expiresAt,
      templateId: packageTemplates.id,
      templateName: packageTemplates.name,
      templatePrice: packageTemplates.totalPrice,
      expiresAfterDays: packageTemplates.expiresAfterDays,
      providerFirst: providers.firstName,
      providerLast: providers.lastName,
      providerCredentials: providers.credentials,
      providerStripeAccount: providers.stripeAccountId,
      providerRevenueModel: providers.revenueModel,
    })
    .from(packageCheckoutLinks)
    .innerJoin(
      packageTemplates,
      eq(packageCheckoutLinks.packageTemplateId, packageTemplates.id),
    )
    .innerJoin(providers, eq(packageCheckoutLinks.providerId, providers.id))
    .where(eq(packageCheckoutLinks.token, token))
    .limit(1)

  if (!row) return null

  const items = await db
    .select({
      serviceName: services.name,
      quantity: packageTemplateItems.quantity,
      perSessionValue: packageTemplateItems.perSessionValue,
    })
    .from(packageTemplateItems)
    .innerJoin(services, eq(packageTemplateItems.serviceId, services.id))
    .where(eq(packageTemplateItems.packageTemplateId, row.templateId))
    .orderBy(services.name)

  const state: LinkState =
    row.status === 'paid'
      ? 'paid'
      : row.status === 'cancelled'
        ? 'cancelled'
        : row.expiresAt < new Date()
          ? 'expired'
          : row.providerRevenueModel !== 'house' && !row.providerStripeAccount
            ? 'unpayable'
            : 'payable'

  return {
    state,
    linkId: row.linkId,
    templateId: row.templateId,
    templateName: row.templateName,
    providerName: `${row.providerFirst} ${row.providerLast}`,
    providerCredentials: row.providerCredentials,
    clientName: row.clientName,
    clientEmail: row.clientEmail,
    // The snapshot, not the template's current price. Sending a link quotes a number, and that
    // is the number owed even if the template is edited afterwards.
    price: Number(row.price) > 0 ? row.price : row.templatePrice,
    expiresAfterDays: row.expiresAfterDays,
    paidAt: row.paidAt,
    expiresAt: row.expiresAt,
    items,
  }
}

export interface PrepaidCheckout {
  state: LinkState
  linkId: string
  amount: string
  providerName: string
  providerCredentials: string | null
  clientName: string | null
  clientEmail: string | null
  /** Set when somebody other than the beneficiary is buying it. The page says so out loud —
   *  a purchaser needs to know the balance will not be theirs. */
  purchaserName: string | null
  purchaserEmail: string | null
  paidAt: Date | null
  expiresAt: Date
}

export async function getPrepaidCheckout(token: string): Promise<PrepaidCheckout | null> {
  const [row] = await db
    .select({
      linkId: prepaidCheckoutLinks.id,
      status: prepaidCheckoutLinks.status,
      amount: prepaidCheckoutLinks.amount,
      purchaserName: prepaidCheckoutLinks.purchaserName,
      purchaserEmail: prepaidCheckoutLinks.purchaserEmail,
      paidAt: prepaidCheckoutLinks.paidAt,
      expiresAt: prepaidCheckoutLinks.expiresAt,
      clientName: clients.name,
      clientEmail: clients.email,
      providerFirst: providers.firstName,
      providerLast: providers.lastName,
      providerCredentials: providers.credentials,
      providerStripeAccount: providers.stripeAccountId,
      providerRevenueModel: providers.revenueModel,
    })
    .from(prepaidCheckoutLinks)
    .innerJoin(clients, eq(prepaidCheckoutLinks.clientId, clients.id))
    .innerJoin(providers, eq(prepaidCheckoutLinks.providerId, providers.id))
    .where(eq(prepaidCheckoutLinks.token, token))
    .limit(1)

  if (!row) return null

  const state: LinkState =
    row.status === 'paid'
      ? 'paid'
      : row.status === 'cancelled'
        ? 'cancelled'
        : row.expiresAt < new Date()
          ? 'expired'
          : // Destination charge, same as a package: without a connected account the provider
            // cannot be paid their share, so there is nothing to collect into.
            row.providerRevenueModel !== 'house' && !row.providerStripeAccount
            ? 'unpayable'
            : 'payable'

  return {
    state,
    linkId: row.linkId,
    amount: row.amount,
    providerName: `${row.providerFirst} ${row.providerLast}`,
    providerCredentials: row.providerCredentials,
    clientName: row.clientName,
    clientEmail: row.clientEmail,
    purchaserName: row.purchaserName,
    purchaserEmail: row.purchaserEmail,
    paidAt: row.paidAt,
    expiresAt: row.expiresAt,
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
