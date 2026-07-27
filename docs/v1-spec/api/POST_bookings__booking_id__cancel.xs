// POST /bookings/{booking_id}/cancel — provider JWT. Spec 3.2.4.
// Cancel an UPCOMING booking; also flips its checkout_link to cancelled (only if still pending —
// a paid link is never silently cancelled; refunds are handled manually in Stripe per locked scope).
// 2026-07-24 (FET-01 Piece 3) GUARD ONLY — no behaviour change for any normal
// booking. If a LIVE (voided_at == null) package_redemptions row points at this
// booking, this endpoint now REFUSES with USE_PACKAGE_CANCEL and the caller must
// use POST /bookings/{booking_id}/cancel-package-redemption #3997225 instead,
// which gives the prepaid session back. Without the guard, cancelling a $0
// redemption from the Appointments page would silently destroy a session the
// client already paid for. Fails closed. Bookings that are not redemptions have
// no package_redemptions row, so the guard is inert for all of them.
query "bookings/{booking_id}/cancel" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text booking_id filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    var $bk_id {
      value = `$input.booking_id`
    }
  
    db.get bookings {
      field_name = "id"
      field_value = `$var.bk_id`
    } as $booking
  
    precondition ($booking != null) {
      error_type = "notfound"
      error = "BOOKING_NOT_FOUND: That booking does not exist."
    }
  
    precondition ($booking.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "BOOKING_NOT_FOUND: That booking does not belong to you."
    }
  
    precondition ($booking.status == "upcoming") {
      error_type = "badrequest"
      error = "CANNOT_CANCEL: Only upcoming bookings can be cancelled."
    }
  
    db.query package_redemptions {
      where = $db.package_redemptions.booking_id == `$var.bk_id`
      return = {type: "list"}
    } as $pkg_reds
  
    var $live_red_count {
      value = `0`
    }
  
    foreach ($pkg_reds) {
      each as $pr {
        conditional {
          if ($pr.voided_at == null) {
            var.update $live_red_count {
              value = `$var.live_red_count|add:1`
            }
          }
        }
      }
    }
  
    precondition ($live_red_count == 0) {
      error_type = "badrequest"
      error = "USE_PACKAGE_CANCEL: This appointment is a prepaid package session. Cancel it from the client's package so the session is given back to them."
    }
  
    db.edit bookings {
      field_name = "id"
      field_value = `$var.bk_id`
      enforce_hidden_fields = false
      data = {status: "cancelled"}
    } as $updated_booking
  
    db.query checkout_links {
      where = $db.checkout_links.booking_id == `$var.bk_id`
      return = {type: "list"}
    } as $links
  
    var $link {
      value = `$var.links.0`
    }
  
    conditional {
      if ($link != null && $link.status == "pending") {
        db.edit checkout_links {
          field_name = "id"
          field_value = `$var.link.id`
          enforce_hidden_fields = false
          data = {status: "cancelled"}
        } as $updated_link
      }
    }
  }

  response = {booking: `$var.updated_booking`}
}