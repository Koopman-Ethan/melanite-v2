//  POST /webhooks/stripe/package — FET-01 Phase 2 (+4b Part D client_name). BUG-16 safe read; always-200; wipe-safe edits.
// 
//  2026-07-25 — FET-01 Phase 5 (steps 4+6). THREE changes:
//    1. NEW charge.refunded branch. Nothing previously set client_packages.status = "refunded",
//       so a refunded package stayed active and the client could keep redeeming sessions they had
//       been refunded for. Mirrors /webhooks/stripe/room #3984603 (resolve by PI -> idempotency
//       guard on an existing refund row -> flip status -> write ledger row), with two deviations:
//       the client_packages edit is FULL-ROW (client_name is nullable — the Lesson-3 wipe rule),
//       and ANY refund (including a partial) locks the whole package; Keoni handles the remainder
//       manually per the refund SOP. REQUIRES charge.refunded to be subscribed in Stripe.
//    2. NEW purchase-confirmation email to the client (spec step 6) — none existed. Sits inside
//       the existing $pi_existing == 0 block so retries can't double-send; guarded on
//       RESEND_API_KEY; api.request never fails the stack, so the always-200 contract holds.
//    3. payout_status now "paid" + payout_date, not "pending". The purchase PI is a destination
//       charge with an application fee (#3995999) — the provider's half settles at purchase and
//       nothing ever flipped this field, so "pending" was simply false.
query "webhooks/stripe/package" verb=POST {
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
      value = `$var.signed|hmac_sha256:$env.STRIPE_WEBHOOK_SECRET_PKG`
    }
  
    db.add webhook_log {
      enforce_hidden_fields = false
      data = {
        destination  : "package"
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
  
    var $meta_type {
      value = `$input.data.object.metadata|get:"type":""`
    }
  
    conditional {
      if ($input.type == "payment_intent.succeeded" && $meta_type == "package_purchase") {
        db.edit webhook_log {
          field_name = "id"
          field_value = `$var.log_row.id`
          enforce_hidden_fields = false
          data = {processed: true}
        } as $wl1
      
        var $pi_id {
          value = `$input.data.object.id`
        }
      
        var $m_link_id {
          value = `$input.data.object.metadata|get:"package_checkout_link_id":""`
        }
      
        var $gross {
          value = `$input.data.object.amount|divide:100`
        }
      
        db.query package_transactions {
          where = $db.package_transactions.stripe_payment_intent_id == `$var.pi_id` && $db.package_transactions.type == "purchase"
          return = {type: "count"}
        } as $pi_existing
      
        db.get package_checkout_links {
          field_name = "id"
          field_value = `$var.m_link_id`
        } as $pkg_link
      
        conditional {
          if ($pi_existing == 0 && $pkg_link != null) {
            db.get package_templates {
              field_name = "id"
              field_value = `$var.pkg_link.package_template_id`
            } as $tpl
          
            db.get platform_settings {
              field_name = "id"
              field_value = 1
            } as $settings
          
            var $tip {
              value = `$var.pkg_link.tip_amount|first_notempty:0`
            }
          
            var $service_portion {
              value = `$var.gross|subtract:$var.tip`
            }
          
            var $provider_payout {
              value = `$var.service_portion|multiply:$var.settings.provider_share_pct|add:$var.tip|round:2`
            }
          
            var $melanite_cut {
              value = `$var.gross|subtract:$var.provider_payout|round:2`
            }
          
            var $payout_day {
              value = `now|format_timestamp:"Y-m-d":"America/Denver"`
            }
          
            db.add package_transactions {
              enforce_hidden_fields = false
              data = {
                provider_id             : `$var.pkg_link.provider_id`
                package_checkout_link_id: `$var.pkg_link.id`
                package_template_id     : `$var.pkg_link.package_template_id`
                type                    : "purchase"
                gross_amount            : `$var.gross`
                tip_amount              : `$var.tip`
                provider_payout         : `$var.provider_payout`
                melanite_cut            : `$var.melanite_cut`
                stripe_payment_intent_id: `$var.pi_id`
                payout_status           : "paid"
                payout_date             : `$var.payout_day`
              }
            } as $pkg_txn
          
            var $exp_at {
              value = null
            }
          
            conditional {
              if ($tpl.expires_after_days != null && $tpl.expires_after_days > 0) {
                var $exp_secs {
                  value = `$var.tpl.expires_after_days|multiply:86400`
                }
              
                var.update $exp_at {
                  value = `now|add_secs_to_timestamp:$var.exp_secs`
                }
              }
            }
          
            db.add client_packages {
              enforce_hidden_fields = false
              data = {
                provider_id            : `$var.pkg_link.provider_id`
                client_email           : `$var.pkg_link.client_email`
                client_name            : `$var.pkg_link.client_name`
                package_template_id    : `$var.pkg_link.package_template_id`
                purchase_transaction_id: `$var.pkg_txn.id`
                status                 : "active"
                purchased_at           : `now`
                expires_at             : `$var.exp_at`
              }
            } as $cpkg
          
            db.query package_template_items {
              where = $db.package_template_items.package_template_id == `$var.pkg_link.package_template_id`
              return = {type: "list"}
            } as $tpl_items
          
            foreach ($tpl_items) {
              each as $item {
                db.add client_package_items {
                  enforce_hidden_fields = false
                  data = {
                    client_package_id: `$var.cpkg.id`
                    service_id       : `$item.service_id`
                    per_session_value: `$item.per_session_value`
                    qty_total        : `$item.quantity`
                    qty_used         : 0
                  }
                } as $cpkg_item
              }
            }
          
            db.edit package_checkout_links {
              field_name = "id"
              field_value = `$var.pkg_link.id`
              enforce_hidden_fields = false
              data = {
                token                   : `$var.pkg_link.token`
                package_template_id     : `$var.pkg_link.package_template_id`
                provider_id             : `$var.pkg_link.provider_id`
                client_email            : `$var.pkg_link.client_email`
                client_name             : `$var.pkg_link.client_name`
                status                  : "paid"
                tip_amount              : `$var.tip`
                stripe_customer_id      : `$var.pkg_link.stripe_customer_id`
                stripe_payment_intent_id: `$var.pi_id`
                paid_at                 : `now`
                expires_at              : `$var.pkg_link.expires_at`
              }
            } as $link_paid
          
            // ---------- FET-01 Phase 5 (step 6): purchase confirmation to the client ----------
            // Inside the $pi_existing == 0 block, so Stripe retries cannot double-send.
            db.get providers {
              field_name = "id"
              field_value = `$var.pkg_link.provider_id`
            } as $pe_prov
          
            var $pe_provname {
              value = `$var.pe_prov.first_name|concat:$var.pe_prov.last_name:" "`
            }
          
            var $pe_expiry {
              value = "No expiration"
            }
          
            conditional {
              if ($exp_at != null) {
                var.update $pe_expiry {
                  value = `$var.exp_at|format_timestamp:"M j, Y":"America/Denver"`
                }
              }
            }
          
            var $pe_items_html {
              value = ""
            }
          
            foreach ($tpl_items) {
              each as $pei {
                db.get services {
                  field_name = "id"
                  field_value = `$pei.service_id`
                } as $pe_svc
              
                var $pe_row {
                  value = `"<li style='margin:4px 0'><strong>"|concat:$pei.quantity|concat:" &times; </strong>"|concat:$var.pe_svc.name|concat:"</li>"`
                }
              
                var.update $pe_items_html {
                  value = `$var.pe_items_html|concat:$var.pe_row`
                }
              }
            }
          
            conditional {
              if ($env.RESEND_API_KEY != "" && $pkg_link.client_email != null && $pkg_link.client_email != "") {
                var $pe_head {
                  value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>Your package is confirmed</h2><p>Thank you for your purchase. Here are the details.</p><table style='width:100%;border-collapse:collapse;margin:16px 0'><tr><td style='padding:6px 0;color:#777'>Package</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.tpl.name|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Provider</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.pe_provname|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Tip</td><td style='padding:6px 0;text-align:right'>$"|concat:$var.tip|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Valid until</td><td style='padding:6px 0;text-align:right'>"|concat:$var.pe_expiry|concat:"</td></tr><tr><td style='padding:10px 0 0;color:#1a1a1a;font-weight:bold;border-top:1px solid #e7e2d8'>Amount paid</td><td style='padding:10px 0 0;text-align:right;font-weight:bold;color:#B8965A;border-top:1px solid #e7e2d8'>$"|concat:$var.gross|concat:"</td></tr></table><p style='margin:18px 0 6px;color:#1a1a1a;font-weight:bold'>What's included</p><ul style='margin:0;padding-left:20px;color:#333'>"`
                }
              
                var $pe_tail {
                  value = `"</ul><div style='margin-top:16px;padding:12px 14px;background:#faf8f4;border:1px solid #e7e2d8'><p style='margin:0 0 6px;color:#1a1a1a;font-weight:bold;font-size:13px'>How to use your package</p><p style='margin:0;color:#555;font-size:13px'>Your provider books each session for you — there is nothing further to pay at your appointments. Contact them directly to schedule, and they can tell you how many sessions you have left at any time.</p></div><div style='margin-top:14px;padding:12px 14px;border:1px solid #e7e2d8'><p style='margin:0 0 6px;color:#1a1a1a;font-weight:bold;font-size:13px'>Cancellations &amp; refunds</p><p style='margin:0;color:#555;font-size:13px'>Individual appointments booked against this package follow the standard policy: cancel more than 24 hours ahead at no charge; cancellations within 24 hours, or no-shows, may forfeit that session at your provider's discretion. For questions about the package itself, contact your provider. <a href='"|concat:$env.APP_BASE_URL|concat:"/refund-policy' style='color:#B8965A'>Read the full policy</a>.</p></div><p style='color:#999;font-size:12px'>Melanite Laser Suite, Boise, Idaho</p></div></div>"`
                }
              
                var $pe_html {
                  value = `$var.pe_head|concat:$var.pe_items_html|concat:$var.pe_tail`
                }
              
                var $pe_subject {
                  value = `"Your Melanite package: "|concat:$var.tpl.name`
                }
              
                api.request {
                  url = "https://api.resend.com/emails"
                  method = "POST"
                  params = {}
                    |set:"from":`$env.RESEND_FROM`
                    |set:"to":`$var.pkg_link.client_email`
                    |set:"subject":`$var.pe_subject`
                    |set:"html":`$var.pe_html`
                  headers = []
                    |push:`"Authorization: Bearer "|concat:$env.RESEND_API_KEY`
                    |push:"Content-Type: application/json"
                } as $pe_email_response
              }
            }
          }
        }
      }
    }
  
    // ---------- FET-01 Phase 5 (step 4 / refund hole): charge.refunded ----------
    // Mirrors /webhooks/stripe/room #3984603. Idempotent on "a refund row already exists for
    // this PI", which also absorbs Stripe's retries. ANY refund — including a partial — locks
    // the package: no further redemption, remainder handled manually per the refund SOP.
    conditional {
      if ($input.type == "charge.refunded") {
        var $rf_pi {
          value = `$input.data.object.payment_intent`
        }
      
        db.query package_transactions {
          where = $db.package_transactions.stripe_payment_intent_id == `$var.rf_pi` && $db.package_transactions.type == "purchase"
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
          
            var $rf_txn {
              value = `$var.rf_matches|first`
            }
          
            db.query package_transactions {
              where = $db.package_transactions.stripe_payment_intent_id == `$var.rf_pi` && $db.package_transactions.type == "refund"
              return = {type: "count"}
            } as $rf_existing
          
            conditional {
              if ($rf_existing == 0) {
                var $rf_amount {
                  value = `$input.data.object.amount_refunded|divide:100`
                }
              
                // scale the original split by the refunded fraction, so a full refund nets
                // every package figure back to zero and a partial nets proportionally
                var $rf_ratio {
                  value = `1`
                }
              
                conditional {
                  if ($rf_txn.gross_amount > 0) {
                    var.update $rf_ratio {
                      value = `$var.rf_amount|divide:$var.rf_txn.gross_amount`
                    }
                  }
                }
              
                var $rf_payout {
                  value = `$var.rf_txn.provider_payout|multiply:$var.rf_ratio|round:2`
                }
              
                var $rf_cut {
                  value = `$var.rf_txn.melanite_cut|multiply:$var.rf_ratio|round:2`
                }
              
                var $rf_tip {
                  value = `$var.rf_txn.tip_amount|multiply:$var.rf_ratio|round:2`
                }
              
                var $rf_note {
                  value = `"charge.refunded on charge "|concat:$input.data.object.id|concat:" - package locked; provider clawback handled manually per the refund SOP"`
                }
              
                db.add package_transactions {
                  enforce_hidden_fields = false
                  data = {
                    provider_id             : `$var.rf_txn.provider_id`
                    package_checkout_link_id: `$var.rf_txn.package_checkout_link_id`
                    package_template_id     : `$var.rf_txn.package_template_id`
                    type                    : "refund"
                    gross_amount            : `$var.rf_amount`
                    tip_amount              : `$var.rf_tip`
                    provider_payout         : `$var.rf_payout`
                    melanite_cut            : `$var.rf_cut`
                    stripe_payment_intent_id: `$var.rf_pi`
                    payout_status           : "paid"
                    note                    : `$var.rf_note`
                  }
                } as $rf_row
              
                db.query client_packages {
                  where = $db.client_packages.purchase_transaction_id == `$var.rf_txn.id`
                  return = {type: "list"}
                } as $rf_pkgs
              
                foreach ($rf_pkgs) {
                  each as $rfp {
                    db.edit client_packages {
                      field_name = "id"
                      field_value = `$rfp.id`
                      enforce_hidden_fields = false
                      data = {
                        provider_id            : `$rfp.provider_id`
                        client_email           : `$rfp.client_email`
                        client_name            : `$rfp.client_name`
                        package_template_id    : `$rfp.package_template_id`
                        purchase_transaction_id: `$rfp.purchase_transaction_id`
                        status                 : "refunded"
                        purchased_at           : `$rfp.purchased_at`
                        expires_at             : `$rfp.expires_at`
                      }
                    } as $rf_pkg_upd
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  response = {received: true}
}