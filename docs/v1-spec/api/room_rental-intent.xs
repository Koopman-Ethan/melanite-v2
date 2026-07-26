// POST /room/rental-intent — FET-05. Gate (booking_enabled + room_rental_enabled flag),
// 60-day window, soft availability pre-check, then a plain PaymentIntent on the PLATFORM
// account (100% platform revenue — NO Connect transfer, NO split). No booking row is
// created here; the webhook is the atomic commit.
query "room/rental-intent" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text rental_date filters=trim
    text slot_type filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition ($provider.booking_enabled) {
      error_type = "accessdenied"
      error = "BOOKING_DISABLED: Room rental is not available on your account. Contact Melanite."
    }
  
    precondition ($provider.room_rental_enabled) {
      error_type = "accessdenied"
      error = "ROOM_RENTAL_REVOKED: Room rental is not available on your account. Contact Melanite."
    }
  
    db.get platform_settings {
      field_name = "id"
      field_value = 1
    } as $settings
  
    precondition ($settings.room_rental_enabled) {
      error_type = "accessdenied"
      error = "ROOM_RENTAL_DISABLED: Room rental is not currently available."
    }
  
    precondition ($input.slot_type == "full" || $input.slot_type == "am" || $input.slot_type == "pm") {
      error_type = "badrequest"
      error = "INVALID_SLOT: slot_type must be full, am, or pm."
    }
  
    var $today_str {
      value = `"now"|format_timestamp:"Y-m-d":"America/Denver"`
    }
  
    var $today_start {
      value = `$var.today_str|concat:" 00:00:00"|parse_timestamp:"Y-m-d H:i:s":"America/Denver"`
    }
  
    var $req_day_start {
      value = `$input.rental_date|concat:" 00:00:00"|parse_timestamp:"Y-m-d H:i:s":"America/Denver"`
    }
  
    precondition ($req_day_start >= $today_start) {
      error_type = "badrequest"
      error = "DATE_IN_PAST: That date has already passed."
    }
  
    var $window_end {
      value = `$var.today_start|add_secs_to_timestamp:5184000`
    }
  
    precondition ($req_day_start <= $window_end) {
      error_type = "badrequest"
      error = "DATE_TOO_FAR: Rentals can be booked up to 60 days in advance."
    }
  
    db.query room_bookings {
      where = $db.room_bookings.rental_date == `$input.rental_date` && $db.room_bookings.status == "confirmed"
      return = {type: "count"}
    } as $day_count
  
    db.query room_bookings {
      where = $db.room_bookings.rental_date == `$input.rental_date` && $db.room_bookings.status == "confirmed" && $db.room_bookings.slot_type == "full"
      return = {type: "count"}
    } as $full_count
  
    db.query room_bookings {
      where = $db.room_bookings.rental_date == `$input.rental_date` && $db.room_bookings.status == "confirmed" && $db.room_bookings.slot_type == `$input.slot_type`
      return = {type: "count"}
    } as $same_count
  
    conditional {
      if ($input.slot_type == "full") {
        precondition ($day_count == 0) {
          error_type = "badrequest"
          error = "SLOT_TAKEN: That day already has a booking."
        }
      }
    }
  
    conditional {
      if ($input.slot_type != "full") {
        precondition ($full_count == 0 && $same_count == 0) {
          error_type = "badrequest"
          error = "SLOT_TAKEN: That block is already booked."
        }
      }
    }
  
    var $price {
      value = `60`
    }
  
    conditional {
      if ($input.slot_type == "full") {
        var.update $price {
          value = `100`
        }
      }
    }
  
    var $amount_cents {
      value = `$var.price|multiply:100|to_int`
    }
  
    api.request {
      url = "https://api.stripe.com/v1/payment_intents"
      method = "POST"
      params = {}
        |set:"amount":`$var.amount_cents`
        |set:"currency":"usd"
        |set:'["payment_method_types[0]"]':"card"
        |set:'["payment_method_types[1]"]':"link"
        |set:'["metadata[type]"]':"room_rental"
        |set:'["metadata[provider_id]"]':`$var.provider.id`
        |set:'["metadata[rental_date]"]':`$input.rental_date`
        |set:'["metadata[slot_type]"]':`$input.slot_type`
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY_ROOM`
        |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
        |push:"Content-Type: application/x-www-form-urlencoded"
    } as $pi_response
  
    precondition ($pi_response.response.result.client_secret != null) {
      error_type = "badrequest"
      error = "STRIPE_ERROR: Could not start the payment. Try again."
    }
  }

  response = {
    client_secret: `$var.pi_response.response.result.client_secret`
    amount       : `$var.price`
    rental_date  : `$input.rental_date`
    slot_type    : `$input.slot_type`
  }
}