// POST /webhooks/stripe/room — FET-05 rental payment webhook, SEPARATE from
// /webhooks/stripe/platform (danger-list: the laser webhook is never edited).
// payment_intent.succeeded + metadata.type=room_rental = the ATOMIC COMMIT:
//   re-run the §3 availability check -> if free, create room_bookings (confirmed)
//   + room_transactions; if taken (double-book race) -> auto-refund in full, create nothing.
// charge.refunded on a rental PI -> mark booking refunded + write ledger row
//   (idempotent: skipped when a refund row already exists — covers the >24h
//   self-cancel echo; catches Keoni's manual <=24h dashboard refunds).
// Always-200, everything logged to webhook_log destination "room".
// Signature verify: HMAC-SHA256 over raw body vs Stripe-Signature v1, secret
// STRIPE_WEBHOOK_SECRET_ROOM (own destination, own secret).
query "webhooks/stripe/room" verb=POST {
  api_group = "melanite_v1"

  input {
    text type? filters=trim
    text id? filters=trim
    json data?
  }

  stack {
    util.get_raw_input {
      encoding = "json"
      exclude_middleware = false
    } as $raw_input
  
    var $headers_obj {
      value = $env.$http_headers
    }
  
    util.get_raw_input {
      encoding = "none"
      exclude_middleware = false
    } as $raw_body
  
    var $sig_header {
      value = `$var.headers_obj|get:"Stripe-Signature"`
    }
  
    var $sig_t {
      value = `$var.sig_header|split:"t="|last|split:","|first`
    }
  
    var $sig_v1 {
      value = `$var.sig_header|split:"v1="|last|split:","|first`
    }
  
    var $signed {
      value = `$var.sig_t|concat:"."|concat:$var.raw_body`
    }
  
    var $computed {
      value = `$var.signed|hmac_sha256:$env.STRIPE_WEBHOOK_SECRET_ROOM`
    }
  
    db.add webhook_log {
      enforce_hidden_fields = false
      data = {
        destination  : "room"
        event_type   : `$input.type`
        event_id     : `$input.id`
        raw_payload  : `$var.raw_input|json_encode`
        headers      : `$var.headers_obj`
        verify_passed: $var.computed == $var.sig_v1
        processed    : false
      }
    } as $log_row
  
    precondition ($computed == $sig_v1) {
      error_type = "accessdenied"
      error = "SIGNATURE_VERIFICATION_FAILED"
    }
  
    conditional {
      if ($input.type == "payment_intent.succeeded" && ($input.data.object.metadata|get:"type":"") == "room_rental") {
        db.edit webhook_log {
          field_name = "id"
          field_value = `$var.log_row.id`
          enforce_hidden_fields = false
          data = {processed: true}
        } as $wl1
      
        var $pi_id {
          value = `$input.data.object.id`
        }
      
        var $m_provider_id {
          value = `$input.data.object.metadata.provider_id`
        }
      
        var $m_date {
          value = `$input.data.object.metadata.rental_date`
        }
      
        var $m_slot {
          value = `$input.data.object.metadata.slot_type`
        }
      
        var $m_amount {
          value = `$input.data.object.amount|divide:100`
        }
      
        db.query room_bookings {
          where = $db.room_bookings.stripe_payment_intent_id == `$var.pi_id`
          return = {type: "count"}
        } as $pi_existing
      
        conditional {
          if ($pi_existing == 0) {
            db.query room_bookings {
              where = $db.room_bookings.rental_date == `$var.m_date` && $db.room_bookings.status == "confirmed"
              return = {type: "count"}
            } as $day_count
          
            db.query room_bookings {
              where = $db.room_bookings.rental_date == `$var.m_date` && $db.room_bookings.status == "confirmed" && $db.room_bookings.slot_type == "full"
              return = {type: "count"}
            } as $full_count
          
            db.query room_bookings {
              where = $db.room_bookings.rental_date == `$var.m_date` && $db.room_bookings.status == "confirmed" && $db.room_bookings.slot_type == `$var.m_slot`
              return = {type: "count"}
            } as $same_count
          
            var $conflict {
              value = `false`
            }
          
            conditional {
              if ($m_slot == "full" && $day_count > 0) {
                var.update $conflict {
                  value = `true`
                }
              }
            }
          
            conditional {
              if ($m_slot != "full" && ($full_count > 0 || $same_count > 0)) {
                var.update $conflict {
                  value = `true`
                }
              }
            }
          
            conditional {
              if ($conflict == false) {
                var $start_time {
                  value = "08:00:00"
                }
              
                conditional {
                  if ($m_slot == "pm") {
                    var.update $start_time {
                      value = "14:00:00"
                    }
                  }
                }
              
                var $end_time {
                  value = "20:00:00"
                }
              
                conditional {
                  if ($m_slot == "am") {
                    var.update $end_time {
                      value = "14:00:00"
                    }
                  }
                }
              
                var $start_at {
                  value = `$var.m_date|concat:" "|concat:$var.start_time|parse_timestamp:"Y-m-d H:i:s":"America/Denver"`
                }
              
                var $end_at {
                  value = `$var.m_date|concat:" "|concat:$var.end_time|parse_timestamp:"Y-m-d H:i:s":"America/Denver"`
                }
              
                db.add room_bookings {
                  enforce_hidden_fields = false
                  data = {
                    provider_id             : `$var.m_provider_id`
                    rental_date             : `$var.m_date`
                    slot_type               : `$var.m_slot`
                    price                   : `$var.m_amount`
                    status                  : "confirmed"
                    stripe_payment_intent_id: `$var.pi_id`
                    start_at                : `$var.start_at`
                    end_at                  : `$var.end_at`
                    active_slot_key         : `$var.m_date|concat:":"|concat:$var.m_slot`
                  }
                } as $rb
              
                db.add room_transactions {
                  enforce_hidden_fields = false
                  data = {
                    room_booking_id         : `$var.rb.id`
                    provider_id             : `$var.m_provider_id`
                    amount                  : `$var.m_amount`
                    type                    : "rental"
                    stripe_payment_intent_id: `$var.pi_id`
                  }
                } as $rt
              }
            }
          
            conditional {
              if ($conflict) {
                api.request {
                  url = "https://api.stripe.com/v1/refunds"
                  method = "POST"
                  params = {}
                    |set:"payment_intent":`$var.pi_id`
                    |set:'["metadata[reason]"]':"room_rental_double_book_auto_refund"
                  headers = []
                    |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY_ROOM`
                    |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
                    |push:"Content-Type: application/x-www-form-urlencoded"
                } as $refund_response
              
                db.add room_transactions {
                  enforce_hidden_fields = false
                  data = {
                    provider_id             : `$var.m_provider_id`
                    amount                  : `$var.m_amount`
                    type                    : "refund"
                    stripe_payment_intent_id: `$var.pi_id`
                    stripe_refund_id        : `$var.refund_response.response.result.id`
                    note                    : "double_book_auto_refund"
                  }
                } as $rt_refund
              }
            }
          }
        }
      }
    }
  
    conditional {
      if ($input.type == "charge.refunded") {
        var $rf_pi {
          value = `$input.data.object.payment_intent`
        }
      
        db.query room_bookings {
          where = $db.room_bookings.stripe_payment_intent_id == `$var.rf_pi`
          return = {type: "list"}
        } as $rf_matches
      
        conditional {
          if (($rf_matches|count) > 0) {
            db.edit webhook_log {
              field_name = "id"
              field_value = `$var.log_row.id`
              enforce_hidden_fields = false
              data = {processed: true}
            } as $wl2
          
            var $rf_rb {
              value = `$var.rf_matches|first`
            }
          
            db.query room_transactions {
              where = $db.room_transactions.stripe_payment_intent_id == `$var.rf_pi` && $db.room_transactions.type == "refund"
              return = {type: "count"}
            } as $rf_existing
          
            conditional {
              if ($rf_existing == 0) {
                db.edit room_bookings {
                  field_name = "id"
                  field_value = `$var.rf_rb.id`
                  enforce_hidden_fields = false
                  data = {
                    status         : "refunded"
                    cancelled_at   : `now`
                    active_slot_key: null
                  }
                } as $rf_upd
              
                db.add room_transactions {
                  enforce_hidden_fields = false
                  data = {
                    room_booking_id         : `$var.rf_rb.id`
                    provider_id             : `$var.rf_rb.provider_id`
                    amount                  : `$input.data.object.amount_refunded|divide:100`
                    type                    : "refund"
                    stripe_payment_intent_id: `$var.rf_pi`
                  }
                } as $rf_txn
              }
            }
          }
        }
      }
    }
  }

  response = {received: true}
}