// POST /room/rentals/{rental_id}/cancel — FET-05. Own booking only.
// >24h before block start (America/Denver): automatic 100% refund + status cancelled + block freed.
// <=24h: status cancellation_requested + block freed + surfaces in Keoni's admin review queue
//   (she refunds manually in Stripe at her discretion; the room webhook's charge.refunded
//   branch then flips the row to refunded automatically).
// NOTE: deliberately NOT gated on room_rental_enabled — rollback must never strand a refund.
query "room/rentals/{rental_id}/cancel" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text rental_id filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.get room_bookings {
      field_name = "id"
      field_value = `$input.rental_id`
    } as $rb
  
    precondition ($rb != null) {
      error_type = "notfound"
      error = "RENTAL_NOT_FOUND: That rental does not exist."
    }
  
    precondition ($rb.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "RENTAL_NOT_FOUND: That rental does not belong to you."
    }
  
    precondition ($rb.status == "confirmed") {
      error_type = "badrequest"
      error = "CANNOT_CANCEL: Only confirmed rentals can be cancelled."
    }
  
    var $now_ms {
      value = `"now"|to_ms`
    }
  
    var $ms_until_start {
      value = `$var.rb.start_at|subtract:$var.now_ms`
    }
  
    var $result {
      value = "cancellation_requested"
    }
  
    conditional {
      if ($ms_until_start > 86400000) {
        api.request {
          url = "https://api.stripe.com/v1/refunds"
          method = "POST"
          params = {}
            |set:"payment_intent":`$var.rb.stripe_payment_intent_id`
            |set:'["metadata[reason]"]':"room_rental_self_cancel_over_24h"
          headers = []
            |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY_ROOM`
            |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
            |push:"Content-Type: application/x-www-form-urlencoded"
        } as $refund_response
      
        precondition ($refund_response.response.result.id != null) {
          error_type = "badrequest"
          error = "STRIPE_REFUND_FAILED: The refund could not be processed. Try again or contact Melanite."
        }
      
        db.edit room_bookings {
          field_name = "id"
          field_value = `$var.rb.id`
          enforce_hidden_fields = false
          data = {
            status         : "cancelled"
            cancelled_at   : `now`
            active_slot_key: null
          }
        } as $rb_cancelled
      
        db.add room_transactions {
          enforce_hidden_fields = false
          data = {
            room_booking_id         : `$var.rb.id`
            provider_id             : `$var.rb.provider_id`
            amount                  : `$var.rb.price`
            type                    : "refund"
            stripe_payment_intent_id: `$var.rb.stripe_payment_intent_id`
            stripe_refund_id        : `$var.refund_response.response.result.id`
            note                    : "self_cancel_over_24h_auto_refund"
          }
        } as $rt
      
        var.update $result {
          value = "cancelled_refunded"
        }
      }
    }
  
    conditional {
      if ($ms_until_start <= 86400000) {
        db.edit room_bookings {
          field_name = "id"
          field_value = `$var.rb.id`
          enforce_hidden_fields = false
          data = {
            status         : "cancellation_requested"
            cancelled_at   : `now`
            active_slot_key: null
          }
        } as $rb_flagged
      }
    }
  
    db.get room_bookings {
      field_name = "id"
      field_value = `$var.rb.id`
    } as $rb_final
  }

  response = {result: `$var.result`, rental: `$var.rb_final`}
}