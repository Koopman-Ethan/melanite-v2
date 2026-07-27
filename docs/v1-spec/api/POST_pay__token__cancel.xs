// POST /pay/{token}/cancel — PUBLIC (token-authenticated). Spec 3.2.5.
// Client bails before paying: flips the pending link to cancelled AND cancels the upcoming booking
// (frees the shared-laser slot for other providers).
query "pay/{token}/cancel" verb=POST {
  api_group = "melanite_v1"

  input {
    text token filters=trim
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
      error = "LINK_NOT_CANCELLABLE: Only a pending payment link can be cancelled."
    }
  
    db.edit checkout_links {
      field_name = "id"
      field_value = `$var.link.id`
      enforce_hidden_fields = false
      data = {status: "cancelled"}
    } as $updated_link
  
    db.get bookings {
      field_name = "id"
      field_value = `$var.link.booking_id`
    } as $booking
  
    conditional {
      if ($booking != null && $booking.status == "upcoming") {
        db.edit bookings {
          field_name = "id"
          field_value = `$var.booking.id`
          enforce_hidden_fields = false
          data = {status: "cancelled"}
        } as $updated_booking
      }
    }
  }

  response = {status: "cancelled"}
}