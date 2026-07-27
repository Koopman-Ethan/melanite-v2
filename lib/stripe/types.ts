// The slices of Stripe's payloads this app actually reads.
//
// Narrow on purpose: a full type surface would imply the app understands more of Stripe than
// it does, and every field here is one v1's webhooks demonstrably depend on.

export interface StripeEvent {
  id: string
  type: string
  created: number
  livemode: boolean
  /** Present on Connect events — identifies the connected account, not the platform. */
  account?: string
  data: { object: Record<string, unknown> }
}

export interface StripePaymentIntentObject {
  id: string
  amount: number
  amount_received: number
  currency: string
  status: string
  application_fee_amount: number | null
  transfer_data: { destination: string } | null
  metadata: Record<string, string> | null
  /** Present once the intent has a confirmed payment method. A bare id — the card's brand and
   *  last four have to be fetched separately. */
  payment_method?: string | null
  customer?: string | null
}

export interface StripePaymentMethodObject {
  id: string
  card?: {
    brand?: string
    last4?: string
    exp_month?: number
    exp_year?: number
  } | null
}

export interface StripeChargeObject {
  id: string
  payment_intent: string | null
  amount: number
  amount_refunded: number
  currency: string
  refunded: boolean
  metadata: Record<string, string> | null
}

export interface StripeInvoiceObject {
  id: string
  amount_paid: number
  amount_due: number
  status: string
  customer: string | null
  subscription?: string | null
  parent?: {
    subscription_details?: { subscription: string; metadata?: Record<string, string> | null }
  } | null
  lines?: { data: Array<{ metadata?: Record<string, string> | null }> }
  status_transitions?: { paid_at: number | null }
}

export interface StripeSubscriptionObject {
  id: string
  status: string
  customer: string | null
  cancel_at_period_end: boolean
  canceled_at: number | null
  metadata: Record<string, string> | null
  items?: { data: Array<{ current_period_end: number }> }
}

export interface StripeCheckoutSessionObject {
  id: string
  mode: string
  customer: string | null
  subscription: string | null
  metadata: Record<string, string> | null
}

export interface StripePayoutObject {
  id: string
  arrival_date: number
  status: string
}

export interface StripeAccountObject {
  id: string
  charges_enabled: boolean
  payouts_enabled: boolean
}

/** What `metadata.type` can say. v1 sets this on every payment intent it creates, and it is
 *  the only reliable way to tell a booking payment from a room rental once the money is in
 *  Stripe — the amount and the account are not distinguishing. */
export type PaymentIntentKind =
  | 'booking_payment'
  | 'room_rental'
  | 'package_purchase'
  | 'training_deposit'
  | 'training_balance'
