// POST /bookings/{booking_id}/cancel-package-redemption — FET-01 Phase 4b,
// Piece 3. The parallel twin of the live bookings/{booking_id}/cancel #3933587
// (danger-list: that one only ever gains a guard, never this logic).
// Cancels a $0 package-redemption booking AND gives the session back, so
// re-booking behaves exactly as if it had never been booked:
//   provider auth -> booking exists -> caller's -> status upcoming -> find the
//   LIVE (voided_at == null) package_redemptions row for this booking_id
//   (NOT_A_PACKAGE_REDEMPTION if none) -> parent package is the caller's ->
//   db.transaction { FULL-ROW decrement of client_package_items.qty_used
//   (floored at 0) -> package exhausted? FULL-ROW flip back to active ->
//   FULL-ROW stamp package_redemptions.voided_at = now -> partial edit of
//   bookings.status = "cancelled" (VERBATIM from the live cancel) }.
// THE SLOT FREES ITSELF: /availability #3933578 and the collision check inside
// create-from-package #3996450 both count only upcoming|completed bookings.
// Locked decisions (2026-07-24): always restore — no cancel-window cutoff; an
// EXPIRED package gets its session back but deliberately STAYS expired (a
// cancellation must not silently override an expiry date), and a REFUNDED
// package is likewise never reactivated. Only exhausted -> active flips.
// The voided row is kept for audit and rendered without a session index — its
// overall_index is legitimately reissued to the next redemption, because that
// index is computed from the sum of qty_used, not from the ledger.
// ZERO Stripe calls — a redemption never moved money (the split settled at
// purchase), so restoring one moves none either.
query "bookings/{booking_id}/cancel-package-redemption" verb=POST {
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
    } as $all_reds
  
    var $red_id {
      value = `""`
    }
  
    foreach ($all_reds) {
      each as $r {
        conditional {
          if ($r.voided_at == null) {
            var.update $red_id {
              value = `$r.id`
            }
          }
        }
      }
    }
  
    precondition (($red_id|strlen) > 0) {
      error_type = "badrequest"
      error = "NOT_A_PACKAGE_REDEMPTION: This booking is not a live package redemption — cancel it the normal way."
    }
  
    db.get package_redemptions {
      field_name = "id"
      field_value = `$var.red_id`
    } as $red
  
    db.get client_packages {
      field_name = "id"
      field_value = `$var.red.client_package_id`
    } as $pkg
  
    precondition ($pkg != null) {
      error_type = "notfound"
      error = "PACKAGE_NOT_FOUND: The package behind this redemption is missing."
    }
  
    precondition ($pkg.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "PACKAGE_NOT_FOUND: That package does not belong to you."
    }
  
    var $pkg_status {
      value = `$var.pkg.status`
    }
  
    db.transaction {
      stack {
        db.get client_package_items {
          field_name = "id"
          field_value = `$var.red.client_package_item_id`
        } as $item_fresh
      
        precondition ($item_fresh != null) {
          error_type = "notfound"
          error = "PACKAGE_LINE_NOT_FOUND: The package line behind this redemption is missing."
        }
      
        var $restored_qty_used {
          value = `$var.item_fresh.qty_used|subtract:1`
        }
      
        conditional {
          if ($restored_qty_used < 0) {
            var.update $restored_qty_used {
              value = `0`
            }
          }
        }
      
        db.edit client_package_items {
          field_name = "id"
          field_value = `$var.item_fresh.id`
          enforce_hidden_fields = false
          data = {
            client_package_id: `$var.item_fresh.client_package_id`
            service_id       : `$var.item_fresh.service_id`
            per_session_value: `$var.item_fresh.per_session_value`
            qty_total        : `$var.item_fresh.qty_total`
            qty_used         : `$var.restored_qty_used`
          }
        } as $item_restored
      
        conditional {
          if ($pkg.status == "exhausted") {
            db.edit client_packages {
              field_name = "id"
              field_value = `$var.pkg.id`
              enforce_hidden_fields = false
              data = {
                provider_id            : `$var.pkg.provider_id`
                client_email           : `$var.pkg.client_email`
                client_name            : `$var.pkg.client_name`
                package_template_id    : `$var.pkg.package_template_id`
                purchase_transaction_id: `$var.pkg.purchase_transaction_id`
                status                 : "active"
                purchased_at           : `$var.pkg.purchased_at`
                expires_at             : `$var.pkg.expires_at`
              }
            } as $pkg_reactivated
          
            var.update $pkg_status {
              value = "active"
            }
          }
        }
      
        db.edit package_redemptions {
          field_name = "id"
          field_value = `$var.red.id`
          enforce_hidden_fields = false
          data = {
            client_package_id     : `$var.red.client_package_id`
            client_package_item_id: `$var.red.client_package_item_id`
            booking_id            : `$var.red.booking_id`
            overall_index         : `$var.red.overall_index`
            service_index         : `$var.red.service_index`
            redeemed_at           : `$var.red.redeemed_at`
            voided_at             : `now`
          }
        } as $red_voided
      
        db.edit bookings {
          field_name = "id"
          field_value = `$var.bk_id`
          enforce_hidden_fields = false
          data = {status: "cancelled"}
        } as $updated_booking
      }
    }
  
    var $line_remaining {
      value = `$var.item_fresh.qty_total|subtract:$var.restored_qty_used`
    }
  
    var $restore_summary {
      value = `{}|set:"redemption_id":$var.red.id|set:"client_package_id":$var.pkg.id|set:"client_package_item_id":$var.item_fresh.id|set:"restored_qty_used":$var.restored_qty_used|set:"line_remaining":$var.line_remaining|set:"package_status":$var.pkg_status`
    }
  }

  response = {
    booking: `$var.updated_booking`
    restore: `$var.restore_summary`
  }
}