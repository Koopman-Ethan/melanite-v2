// Stripe webhook receiver — CONNECT (connected accounts) scope. Spec 3.2.7 adds payout reconciliation.
//   account.updated -> stripe_onboarding_complete = charges_enabled && payouts_enabled (unchanged, proven).
//   payout.paid     -> find provider by the event's top-level account id; flip ALL of that provider's
//                      pending transactions to payout_status=paid + payout_date=arrival_date.
//                      (v1 sweep approximation per spec: Stripe doesn't map payouts->PIs cleanly in test mode.)
//   payout.failed   -> same lookup; flip pending -> failed (ops attention signal).
// Signature verification: REAL & GATING (Spec §6, live 2026-06-15) — HMAC-SHA256 over raw body vs Stripe-Signature v1; mismatch → 403 SIGNATURE_VERIFICATION_FAILED.
query "webhooks/stripe/connect" verb=POST {
  api_group = "melanite_v1"

  input {
    text type? filters=trim
    text id? filters=trim
    text account? filters=trim
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
      value = `$var.signed|hmac_sha256:$env.STRIPE_WEBHOOK_SECRET_CONNECT`
    }
  
    db.add webhook_log {
      enforce_hidden_fields = false
      data = {
        destination  : "connect"
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
      if (`$input.type` == "account.updated") {
        db.query providers {
          where = $db.providers.stripe_account_id == `$input.data.object.id`
          return = {type: "list"}
        } as $matching_providers
      
        conditional {
          if (`$var.matching_providers|count` > 0) {
            var $onboarding_complete {
              value = false
            }
          
            conditional {
              if (`$input.data.object.charges_enabled` && `$input.data.object.payouts_enabled`) {
                var.update $onboarding_complete {
                  value = true
                }
              }
            }
          
            db.edit providers {
              field_name = "id"
              field_value = $matching_providers[0].id
              enforce_hidden_fields = false
              data = {stripe_onboarding_complete: `$var.onboarding_complete`}
            } as $providers1
          
            db.edit webhook_log {
              field_name = "id"
              field_value = `$var.log_row.id`
              enforce_hidden_fields = false
              data = {processed: true}
            } as $webhook_log1
          }
        }
      }
    }
  
    conditional {
      if ($input.type == "payout.paid") {
        db.query providers {
          where = $db.providers.stripe_account_id == `$input.account`
          return = {type: "list"}
        } as $payout_providers
      
        conditional {
          if (`$var.payout_providers|count` > 0) {
            var $payout_date_str {
              value = `$input.data.object.arrival_date|multiply:1000|format_timestamp:"Y-m-d":"America/Denver"`
            }
          
            db.query transactions {
              where = $db.transactions.provider_id == `$var.payout_providers.0.id` && $db.transactions.payout_status == "pending"
              return = {type: "list"}
            } as $pending_txns
          
            foreach ($pending_txns) {
              each as $txn {
                db.edit transactions {
                  field_name = "id"
                  field_value = `$txn.id`
                  enforce_hidden_fields = false
                  data = {
                    payout_status: "paid"
                    payout_date  : `$var.payout_date_str`
                  }
                } as $txn_paid
              }
            }
          
            db.edit webhook_log {
              field_name = "id"
              field_value = `$var.log_row.id`
              enforce_hidden_fields = false
              data = {processed: true}
            } as $webhook_log_payout
          }
        }
      }
    }
  
    conditional {
      if ($input.type == "payout.failed") {
        db.query providers {
          where = $db.providers.stripe_account_id == `$input.account`
          return = {type: "list"}
        } as $failed_providers
      
        conditional {
          if (`$var.failed_providers|count` > 0) {
            db.query transactions {
              where = $db.transactions.provider_id == `$var.failed_providers.0.id` && $db.transactions.payout_status == "pending"
              return = {type: "list"}
            } as $affected_txns
          
            foreach ($affected_txns) {
              each as $txn {
                db.edit transactions {
                  field_name = "id"
                  field_value = `$txn.id`
                  enforce_hidden_fields = false
                  data = {payout_status: "failed"}
                } as $txn_failed
              }
            }
          
            db.edit webhook_log {
              field_name = "id"
              field_value = `$var.log_row.id`
              enforce_hidden_fields = false
              data = {processed: true}
            } as $webhook_log_payout_failed
          }
        }
      }
    }
  }

  response = {received: true}
}