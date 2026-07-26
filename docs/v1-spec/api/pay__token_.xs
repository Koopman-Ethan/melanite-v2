// GET /pay/{token} — PUBLIC (token-authenticated). Spec 3.2.5.
// Loads checkout-link + booking + provider display data for the client checkout page.
// Status routing for the frontend: paid -> already-paid view (returned, not an error);
// cancelled -> LINK_CANCELLED error; expired (incl. just-in-time flip of stale pending links) -> LINK_EXPIRED error.
query "pay/{token}" verb=GET {
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
  
    precondition ($link.status != "cancelled") {
      error_type = "badrequest"
      error = "LINK_CANCELLED: This payment link was cancelled."
    }
  
    var $status {
      value = `$var.link.status`
    }
  
    conditional {
      if ($link.status == "pending" && $link.expires_at < now) {
        db.edit checkout_links {
          field_name = "id"
          field_value = `$var.link.id`
          enforce_hidden_fields = false
          data = {status: "expired"}
        } as $expired_link
      
        var.update $status {
          value = "expired"
        }
      }
    }
  
    precondition ($status != "expired") {
      error_type = "badrequest"
      error = "LINK_EXPIRED: This payment link has expired."
    }
  
    db.get bookings {
      field_name = "id"
      field_value = `$var.link.booking_id`
    } as $booking
  
    db.get providers {
      field_name = "id"
      field_value = `$var.booking.provider_id`
    } as $prov
  
    db.get provider_services {
      field_name = "id"
      field_value = `$var.booking.provider_service_id`
    } as $ps
  
    db.get services {
      field_name = "id"
      field_value = `$var.ps.service_id`
    } as $service
  
    var $resp_booking {
      value = `{}|set:"client_name":$var.booking.client_name|set:"treatment_area":$var.booking.treatment_area|set:"price":$var.booking.price|set:"original_price":$var.booking.original_price|set:"discount_pct":$var.booking.discount_pct|set:"start_time":$var.booking.start_time|set:"duration_mins":$var.booking.duration_mins|set:"status":$var.booking.status`
    }
  
    var $resp_provider {
      value = `{}|set:"first_name":$var.prov.first_name|set:"last_name":$var.prov.last_name|set:"credentials":$var.prov.credentials`
    }
  }

  response = {
    status      : `$var.status`
    tip_amount  : `$var.link.tip_amount`
    paid_at     : `$var.link.paid_at`
    expires_at  : `$var.link.expires_at`
    booking     : `$var.resp_booking`
    provider    : `$var.resp_provider`
    service_name: `$var.service.name`
  }
}