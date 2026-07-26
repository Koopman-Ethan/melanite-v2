// POST /pay/{token}/pay — PUBLIC (token-authenticated). Spec 3.2.5. Body: { tip_amount }.
// DESTINATION CHARGE on the platform account: transfer_data[destination] (NO on_behalf_of — provider accounts have transfers capability only, 2026-06-11 fix) = provider's
// connected account; application_fee_amount = round(price * (1 - provider_share_pct) * 100) — TIPS EXCLUDED
// (100% of tip goes to the provider via the destination transfer). NO setup_future_usage this phase.
// Retry behavior v1: re-calling creates a fresh PaymentIntent and overwrites the saved PI id (handles
// tip changes; the orphaned unconfirmed PI simply expires — simpler than PI amount-update).
query "pay/{token}/pay" verb=POST {
  api_group = "melanite_v1"

  input {
    text token filters=trim
    decimal? tip_amount?=0
    text? client_email? filters=trim
    bool? policy_ack?
    text? policy_version? filters=trim
  }

  stack {
    var $tok {
      value = `$input.token`
    }
  
    db.get checkout_links {
      field_name = "token"
      field_value = `$var.tok`
    } as $link
  
    precondition ($link != null) {
      error_type = "notfound"
      error = "LINK_NOT_FOUND: That payment link does not exist."
    }
  
    precondition ($link.status == "pending") {
      error_type = "badrequest"
      error = "LINK_NOT_PAYABLE: This payment link is no longer payable."
    }
  
    precondition ($link.expires_at > now) {
      error_type = "badrequest"
      error = "LINK_EXPIRED: This payment link has expired."
    }
  
    var $tip {
      value = `$input.tip_amount|first_notempty:0`
    }
  
    precondition ($tip >= 0) {
      error_type = "badrequest"
      error = "INVALID_TIP: tip_amount cannot be negative."
    }
  
    db.get bookings {
      field_name = "id"
      field_value = `$var.link.booking_id`
    } as $booking
  
    precondition ($booking.status == "upcoming") {
      error_type = "badrequest"
      error = "BOOKING_NOT_PAYABLE: This booking is no longer payable."
    }
  
    db.get providers {
      field_name = "id"
      field_value = `$var.booking.provider_id`
    } as $prov
  
    precondition ($prov.stripe_account_id != null) {
      error_type = "badrequest"
      error = "PROVIDER_NOT_PAYABLE: The provider cannot accept payments yet."
    }
  
    db.get platform_settings {
      field_name = "id"
      field_value = 1
    } as $settings
  
    var $platform_pct {
      value = `1|subtract:$var.settings.provider_share_pct`
    }
  
    var $amount_cents {
      value = `$var.booking.price|add:$var.tip|multiply:100|round|to_int`
    }
  
    var $fee_cents {
      value = `$var.booking.price|multiply:$var.platform_pct|multiply:100|round|to_int`
    }
  
    function.run find_or_create_stripe_customer {
      input = {
        provider_id: $prov.id
        name       : $booking.client_name
        phone      : $booking.client_phone
      }
    } as $customer_id
  
    api.request {
      url = "https://api.stripe.com/v1/payment_intents"
      method = "POST"
      params = {}
        |set:"amount":`$var.amount_cents`
        |set:"currency":"usd"
        |set:"customer":`$var.customer_id`
        |set:'["automatic_payment_methods[enabled]"]':"true"
        |set:'["transfer_data[destination]"]':`$var.prov.stripe_account_id`
        |set:"application_fee_amount":`$var.fee_cents`
        |set:'["metadata[type]"]':"booking_payment"
        |set:'["metadata[checkout_link_id]"]':`$var.link.id`
        |set:'["metadata[booking_id]"]':`$var.booking.id`
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
        |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
        |push:"Content-Type: application/x-www-form-urlencoded"
    } as $pi_response
  
    db.edit checkout_links {
      field_name = "id"
      field_value = `$var.link.id`
      enforce_hidden_fields = false
      data = {
        stripe_customer_id      : `$var.customer_id`
        stripe_payment_intent_id: `$var.pi_response.response.result.id`
        tip_amount              : `$var.tip`
      }
    } as $link_updated
  
    var $cemail {
      value = `$input.client_email|first_notempty:""`
    }
  
    conditional {
      if ($cemail != "") {
        db.edit bookings {
          field_name = "id"
          field_value = `$var.booking.id`
          enforce_hidden_fields = false
          data = {client_email: `$var.cemail`}
        } as $booking_email_updated
      }
    }
  
    var $pver {
      value = `$input.policy_version|first_notempty:"2026-07-06.v1"`
    }
  
    conditional {
      if ($input.policy_ack) {
        db.edit bookings {
          field_name = "id"
          field_value = `$var.booking.id`
          enforce_hidden_fields = false
          data = {policy_ack_at: `now`, policy_ack_version: `$var.pver`}
        } as $booking_policy_updated
      }
    }
  }

  response = {
    client_secret: `$var.pi_response.response.result.client_secret`
  }
}