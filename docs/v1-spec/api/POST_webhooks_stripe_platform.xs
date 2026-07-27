// Stripe webhook receiver — platform account scope. Spec 3.2.6.
// payment_intent.succeeded routing by metadata.type:
//   booking_payment  -> flip checkout_links to paid (+paid_at, PI id) and WRITE THE transactions ROW
//                       (splits computed from platform_settings.provider_share_pct at write time; tips 100% to provider).
//                       Idempotent: skips if a transactions row already exists for this PI (webhook retries).
//   training_deposit -> training_enrollments.deposit_paid = true
//   training_balance -> training_enrollments.balance_paid = true
// FET-16 (2026-07-15): training_deposit ALSO emails Keoni (melanitelasersuite@gmail.com)
//   once per enrollment (guarded by $t_already + RESEND_API_KEY, like the student emails).
// Signature verification: REAL & GATING (Spec §6, live 2026-06-15) — HMAC-SHA256 over raw body vs Stripe-Signature v1; mismatch → 403 SIGNATURE_VERIFICATION_FAILED.
query "webhooks/stripe/platform" verb=POST {
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
      value = `$var.signed|hmac_sha256:$env.STRIPE_WEBHOOK_SECRET_PLATFORM`
    }
  
    db.add webhook_log {
      enforce_hidden_fields = false
      data = {
        destination  : "platform"
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
      if ($input.type == "payment_intent.succeeded") {
        db.edit webhook_log {
          field_name = "id"
          field_value = `$var.log_row.id`
          enforce_hidden_fields = false
          data = {processed: true}
        } as $webhook_log1
      
        var $pi_meta_type {
          value = `$input.data.object.metadata.type`
        }
      
        var $pi_enrollment_id {
          value = `$input.data.object.metadata.training_enrollment_id`
        }
      
        var $pi_checkout_link_id {
          value = `$input.data.object.metadata.checkout_link_id`
        }
      
        var $pi_id {
          value = `$input.data.object.id`
        }
      
        conditional {
          if ($pi_meta_type == "training_deposit") {
            db.get training_enrollments {
              field_name = "id"
              field_value = `$var.pi_enrollment_id`
            } as $tenr_prev
          
            var $t_already {
              value = `false`
            }
          
            conditional {
              if ($tenr_prev.deposit_paid) {
                var.update $t_already {
                  value = `true`
                }
              }
            }
          
            db.edit training_enrollments {
              field_name = "id"
              field_value = `$var.pi_enrollment_id`
              enforce_hidden_fields = false
              data = {deposit_paid: true}
            } as $training_deposit_flip
          
            conditional {
              if ($t_already == false) {
                db.get training_courses {
                  field_name = "id"
                  field_value = `$var.tenr_prev.training_course_id`
                } as $tc_cur
              
                var $t_charge {
                  value = `$input.data.object.amount|divide:100`
                }
              
                var $t_paid {
                  value = `$var.tenr_prev.amount_paid|add:$var.t_charge`
                }
              
                var $t_bal {
                  value = `$var.tc_cur.total_price|subtract:$var.t_paid`
                }
              
                conditional {
                  if ($t_bal < 0) {
                    var.update $t_bal {
                      value = `0`
                    }
                  }
                }
              
                var $t_status {
                  value = "partial"
                }
              
                var $t_balpaid {
                  value = `false`
                }
              
                conditional {
                  if ($t_bal == 0) {
                    var.update $t_status {
                      value = "paid_in_full"
                    }
                  
                    var.update $t_balpaid {
                      value = `true`
                    }
                  }
                }
              
                db.edit training_enrollments {
                  field_name = "id"
                  field_value = `$var.pi_enrollment_id`
                  enforce_hidden_fields = false
                  data = {
                    amount_paid     : `$var.t_paid`
                    balance_due     : `$var.t_bal`
                    payment_status  : `$var.t_status`
                    balance_paid    : `$var.t_balpaid`
                    balance_due_date: `$var.tc_cur.day1_date`
                  }
                } as $t_amounts_upd
              }
            }
          
            // --- Deposit confirmation email (mirrors the proven forgot-password Resend call) ---
            db.get training_enrollments {
              field_name = "id"
              field_value = `$var.pi_enrollment_id`
            } as $tenr_conf
          
            db.get training_courses {
              field_name = "id"
              field_value = `$var.tenr_conf.training_course_id`
            } as $tc_conf
          
            var $tconf_balance {
              value = `$var.tenr_conf.balance_due`
            }
          
            conditional {
              if ($env.RESEND_API_KEY != "" && $t_already == false && $tconf_balance > 0) {
                var $tconf_html {
                  value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>You're reserved, "|concat:$var.tenr_conf.first_name|concat:"!</h2><p>Your $"|concat:$var.tenr_conf.deposit_amount|concat:" deposit for your Laser Certification Training is confirmed.</p><p style='color:#555'>Day 1: "|concat:$var.tc_conf.day1_date|concat:"<br>Day 2: "|concat:$var.tc_conf.day2_date|concat:"</p><p>The remaining $"|concat:$var.tconf_balance|concat:" balance is due by "|concat:$var.tenr_conf.balance_due_date|concat:".</p><div style='text-align:center;margin:20px 0'><a href='"|concat:$env.APP_BASE_URL|concat:"/training-balance?e="|concat:$var.tenr_conf.id|concat:"' style='background:#B8965A;color:#ffffff;text-decoration:none;padding:12px 28px;display:inline-block;font-weight:bold'>Pay your remaining balance</a></div><p style='color:#555;font-size:13px'>Or paste this link into your browser: "|concat:$env.APP_BASE_URL|concat:"/training-balance?e="|concat:$var.tenr_conf.id|concat:"</p><p>Questions? Contact melanitelasersuite@gmail.com.</p></div></div>"`
                }
              
                api.request {
                  url = "https://api.resend.com/emails"
                  method = "POST"
                  params = {}
                    |set:"from":`$env.RESEND_FROM`
                    |set:"to":`$var.tenr_conf.email`
                    |set:"subject":"Your Melanite training seat is reserved"
                    |set:"html":`$var.tconf_html`
                  headers = []
                    |push:`"Authorization: Bearer "|concat:$env.RESEND_API_KEY`
                    |push:"Content-Type: application/json"
                } as $tconf_email_response
              }
            }
          
            conditional {
              if ($env.RESEND_API_KEY != "" && $t_already == false && $tconf_balance == 0) {
                var $tpaid_html {
                  value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>You're paid in full, "|concat:$var.tenr_conf.first_name|concat:"!</h2><p>Your Laser Certification Training is fully paid. Nothing more is owed.</p><p style='color:#555'>Day 1: "|concat:$var.tc_conf.day1_date|concat:"<br>Day 2: "|concat:$var.tc_conf.day2_date|concat:"</p><p>See you in class! Questions? Contact melanitelasersuite@gmail.com.</p></div></div>"`
                }
              
                api.request {
                  url = "https://api.resend.com/emails"
                  method = "POST"
                  params = {}
                    |set:"from":`$env.RESEND_FROM`
                    |set:"to":`$var.tenr_conf.email`
                    |set:"subject":"Your Melanite training is paid in full"
                    |set:"html":`$var.tpaid_html`
                  headers = []
                    |push:`"Authorization: Bearer "|concat:$env.RESEND_API_KEY`
                    |push:"Content-Type: application/json"
                } as $tpaid_email_response
              }
            }
          
            // --- FET-16 (2026-07-15): notify Keoni on every NEW training deposit ---
            // Fires once per enrollment ($t_already guard = same idempotency as the
            // student emails above). All enrollment writes are already committed
            // above, and api.request doesn't fail the stack on a non-2xx — a failed
            // send can never fail the enrollment. Recipient confirmed by Ethan
            // 2026-07-15. Silent no-op while RESEND_API_KEY is unset.
            conditional {
              if ($env.RESEND_API_KEY != "" && $t_already == false) {
                var $fet16_phone {
                  value = `$var.tenr_conf.phone`
                }
              
                conditional {
                  if ($fet16_phone == null || $fet16_phone == "") {
                    var.update $fet16_phone {
                      value = "not provided"
                    }
                  }
                }
              
                var $fet16_license {
                  value = `$var.tenr_conf.license_number`
                }
              
                conditional {
                  if ($fet16_license == null || $fet16_license == "") {
                    var.update $fet16_license {
                      value = "not provided"
                    }
                  }
                }
              
                var $fet16_deposit {
                  value = `$input.data.object.amount|divide:100`
                }
              
                var $fet16_balline {
                  value = `"$"|concat:$var.tenr_conf.balance_due|concat:" due by "|concat:$var.tenr_conf.balance_due_date`
                }
              
                conditional {
                  if ($tconf_balance == 0) {
                    var.update $fet16_balline {
                      value = "Paid in full — nothing owed"
                    }
                  }
                }
              
                var $fet16_html {
                  value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>New training signup</h2><p>A student just paid their deposit for Laser Certification Training.</p><table style='width:100%;border-collapse:collapse;margin:16px 0'><tr><td style='padding:6px 0;color:#777'>Student</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.tenr_conf.first_name|concat:" "|concat:$var.tenr_conf.last_name|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Email</td><td style='padding:6px 0;text-align:right'>"|concat:$var.tenr_conf.email|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Phone</td><td style='padding:6px 0;text-align:right'>"|concat:$var.fet16_phone|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>License #</td><td style='padding:6px 0;text-align:right'>"|concat:$var.fet16_license|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Course Day 1</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.tc_conf.day1_date|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Course Day 2</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.tc_conf.day2_date|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Deposit paid</td><td style='padding:6px 0;text-align:right;font-weight:bold;color:#B8965A'>$"|concat:$var.fet16_deposit|concat:"</td></tr><tr><td style='padding:10px 0 0;color:#1a1a1a;font-weight:bold;border-top:1px solid #e7e2d8'>Balance</td><td style='padding:10px 0 0;text-align:right;font-weight:bold;border-top:1px solid #e7e2d8'>"|concat:$var.fet16_balline|concat:"</td></tr></table><p style='color:#999;font-size:12px'>Enrollment ID: "|concat:$var.tenr_conf.id|concat:"</p></div></div>"`
                }
              
                api.request {
                  url = "https://api.resend.com/emails"
                  method = "POST"
                  params = {}
                    |set:"from":`$env.RESEND_FROM`
                    |set:"to":"melanitelasersuite@gmail.com"
                    |set:"subject":`"New training signup: "|concat:$var.tenr_conf.first_name|concat:" "|concat:$var.tenr_conf.last_name`
                    |set:"html":`$var.fet16_html`
                  headers = []
                    |push:`"Authorization: Bearer "|concat:$env.RESEND_API_KEY`
                    |push:"Content-Type: application/json"
                } as $fet16_email_response
              }
            }
          }
        }
      
        conditional {
          if ($pi_meta_type == "training_balance") {
            db.get training_enrollments {
              field_name = "id"
              field_value = `$var.pi_enrollment_id`
            } as $benr_prev
          
            var $b_already {
              value = `false`
            }
          
            conditional {
              if ($benr_prev.balance_paid) {
                var.update $b_already {
                  value = `true`
                }
              }
            }
          
            conditional {
              if ($b_already == false) {
                db.get training_courses {
                  field_name = "id"
                  field_value = `$var.benr_prev.training_course_id`
                } as $bc_cur
              
                var $b_charge {
                  value = `$input.data.object.amount|divide:100`
                }
              
                var $b_paid {
                  value = `$var.benr_prev.amount_paid|add:$var.b_charge`
                }
              
                var $b_bal {
                  value = `$var.bc_cur.total_price|subtract:$var.b_paid`
                }
              
                conditional {
                  if ($b_bal < 0) {
                    var.update $b_bal {
                      value = `0`
                    }
                  }
                }
              
                var $b_status {
                  value = "partial"
                }
              
                var $b_balpaid {
                  value = `false`
                }
              
                conditional {
                  if ($b_bal == 0) {
                    var.update $b_status {
                      value = "paid_in_full"
                    }
                  
                    var.update $b_balpaid {
                      value = `true`
                    }
                  }
                }
              
                db.edit training_enrollments {
                  field_name = "id"
                  field_value = `$var.pi_enrollment_id`
                  enforce_hidden_fields = false
                  data = {
                    amount_paid   : `$var.b_paid`
                    balance_due   : `$var.b_bal`
                    payment_status: `$var.b_status`
                    balance_paid  : `$var.b_balpaid`
                  }
                } as $b_amounts_upd
              
                conditional {
                  if ($env.RESEND_API_KEY != "" && $b_bal == 0) {
                    var $bpaid_html {
                      value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>You're paid in full, "|concat:$var.benr_prev.first_name|concat:"!</h2><p>Your remaining balance is paid. Your Laser Certification Training is fully covered.</p><p style='color:#555'>Day 1: "|concat:$var.bc_cur.day1_date|concat:"<br>Day 2: "|concat:$var.bc_cur.day2_date|concat:"</p><p>See you in class! Questions? Contact melanitelasersuite@gmail.com.</p></div></div>"`
                    }
                  
                    api.request {
                      url = "https://api.resend.com/emails"
                      method = "POST"
                      params = {}
                        |set:"from":`$env.RESEND_FROM`
                        |set:"to":`$var.benr_prev.email`
                        |set:"subject":"Your Melanite training is paid in full"
                        |set:"html":`$var.bpaid_html`
                      headers = []
                        |push:`"Authorization: Bearer "|concat:$env.RESEND_API_KEY`
                        |push:"Content-Type: application/json"
                    } as $bpaid_email_response
                  }
                }
              }
            }
          }
        }
      
        conditional {
          if ($pi_meta_type == "booking_payment") {
            db.get checkout_links {
              field_name = "id"
              field_value = `$var.pi_checkout_link_id`
            } as $cl
          
            db.query transactions {
              where = $db.transactions.stripe_payment_intent_id == `$var.pi_id`
              return = {type: "count"}
            } as $existing_txn_count
          
            conditional {
              if ($cl != null && $existing_txn_count == 0) {
                db.edit checkout_links {
                  field_name = "id"
                  field_value = `$var.cl.id`
                  enforce_hidden_fields = false
                  data = {
                    status                  : "paid"
                    paid_at                 : `now`
                    stripe_payment_intent_id: `$var.pi_id`
                  }
                } as $cl_paid
              
                db.get bookings {
                  field_name = "id"
                  field_value = `$var.cl.booking_id`
                } as $bk
              
                db.get platform_settings {
                  field_name = "id"
                  field_value = 1
                } as $settings
              
                var $provider_share {
                  value = `$var.bk.price|multiply:$var.settings.provider_share_pct`
                }
              
                var $provider_payout {
                  value = `$var.provider_share|add:$var.cl.tip_amount`
                }
              
                var $melanite_cut {
                  value = `$var.bk.price|subtract:$var.provider_share`
                }
              
                db.add transactions {
                  enforce_hidden_fields = false
                  data = {
                    provider_id             : `$var.bk.provider_id`
                    booking_id              : `$var.bk.id`
                    checkout_link_id        : `$var.cl.id`
                    source                  : "booking"
                    gross_amount            : `$var.bk.price`
                    tip_amount              : `$var.cl.tip_amount`
                    provider_payout         : `$var.provider_payout`
                    melanite_cut            : `$var.melanite_cut`
                    stripe_payment_intent_id: `$var.pi_id`
                    payout_status           : "pending"
                  }
                } as $txn
              
                // --- Branded receipt email to the client (mirrors training-deposit Resend call) ---
                db.get providers {
                  field_name = "id"
                  field_value = `$var.bk.provider_id`
                } as $rcpt_prov
              
                db.get provider_services {
                  field_name = "id"
                  field_value = `$var.bk.provider_service_id`
                } as $rcpt_ps
              
                db.get services {
                  field_name = "id"
                  field_value = `$var.rcpt_ps.service_id`
                } as $rcpt_svc
              
                var $rcpt_svc_name {
                  value = `$var.rcpt_svc.name`
                }
              
                var $rcpt_total {
                  value = `$var.bk.price|add:$var.cl.tip_amount`
                }
              
                var $rcpt_when {
                  value = `$var.bk.start_time|format_timestamp:"D, M j, Y, g:i A":"America/Denver"`
                }
              
                var $rcpt_provname {
                  value = `$var.rcpt_prov.first_name|concat:$var.rcpt_prov.last_name:" "`
                }
              
                conditional {
                  if ($env.RESEND_API_KEY != "" && $bk.client_email != null && $bk.client_email != "") {
                    var $rcpt_html {
                      value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>Payment received - thank you!</h2><p>We've received your payment for your appointment below.</p><table style='width:100%;border-collapse:collapse;margin:16px 0'><tr><td style='padding:6px 0;color:#777'>Service</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.rcpt_svc_name|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Provider</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.rcpt_provname|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Appointment</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.rcpt_when|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Subtotal</td><td style='padding:6px 0;text-align:right'>$"|concat:$var.bk.price|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Tip</td><td style='padding:6px 0;text-align:right'>$"|concat:$var.cl.tip_amount|concat:"</td></tr><tr><td style='padding:10px 0 0;color:#1a1a1a;font-weight:bold;border-top:1px solid #e7e2d8'>Amount paid</td><td style='padding:10px 0 0;text-align:right;font-weight:bold;color:#B8965A;border-top:1px solid #e7e2d8'>$"|concat:$var.rcpt_total|concat:"</td></tr></table><p style='color:#555'>Questions about your appointment? Contact your provider directly using the number they sent with your booking link.</p><div style='margin-top:14px;padding:12px 14px;border:1px solid #e7e2d8'><p style='margin:0 0 6px;color:#1a1a1a;font-weight:bold;font-size:13px'>Cancellations &amp; refunds</p><p style='margin:0;color:#555;font-size:13px'>Cancel more than 24 hours before your appointment for a full refund. Cancellations within 24 hours, or no-shows, may be charged a fee of up to 50% of the service price, at your provider's discretion. If you are unhappy with a result, you may request a refund review within 8 weeks of treatment. <a href='"|concat:$env.APP_BASE_URL|concat:"/refund-policy' style='color:#B8965A'>Read the full policy</a>.</p></div><p style='color:#999;font-size:12px'>Melanite Laser Suite, Boise, Idaho</p></div></div>"`
                    }
                  
                    api.request {
                      url = "https://api.resend.com/emails"
                      method = "POST"
                      params = {}
                        |set:"from":`$env.RESEND_FROM`
                        |set:"to":`$var.bk.client_email`
                        |set:"subject":"Your Melanite Laser Suite payment receipt"
                        |set:"html":`$var.rcpt_html`
                      headers = []
                        |push:`"Authorization: Bearer "|concat:$env.RESEND_API_KEY`
                        |push:"Content-Type: application/json"
                    } as $rcpt_email_response
                  }
                }
              }
            }
          }
        }
      }
    }
  
    // --- Medical-director subscription: activation (checkout.session.completed, mode=subscription) ---
    conditional {
      if ($input.type == "checkout.session.completed" && $input.data.object.mode == "subscription") {
        db.edit webhook_log {
          field_name = "id"
          field_value = `$var.log_row.id`
          enforce_hidden_fields = false
          data = {processed: true}
        } as $sub_log1
      
        var $cs_provider_id {
          value = `$input.data.object.metadata.provider_id`
        }
      
        var $cs_subscription_id {
          value = `$input.data.object.subscription`
        }
      
        var $cs_customer_id {
          value = `$input.data.object.customer`
        }
      
        db.query memberships {
          where = $db.memberships.stripe_subscription_id == `$var.cs_subscription_id`
          return = {type: "list"}
        } as $cs_existing
      
        conditional {
          if (($cs_existing|count) == 0) {
            db.add memberships {
              enforce_hidden_fields = false
              data = {
                provider_id           : `$var.cs_provider_id`
                plan_type             : "medical_director"
                stripe_subscription_id: `$var.cs_subscription_id`
                stripe_customer_id    : `$var.cs_customer_id`
                status                : "active"
                start_date            : `now`
              }
            } as $cs_new_membership
          
            db.edit providers {
              field_name = "id"
              field_value = `$var.cs_provider_id`
              enforce_hidden_fields = false
              data = {
                stripe_subscription_id : `$var.cs_subscription_id`
                medical_director_status: "active"
              }
            } as $cs_prov_update
          }
        }
      }
    }
  
    // --- invoice.payment_succeeded -> active (renewals) ---
    conditional {
      if ($input.type == "invoice.payment_succeeded") {
        db.edit webhook_log {
          field_name = "id"
          field_value = `$var.log_row.id`
          enforce_hidden_fields = false
          data = {processed: true}
        } as $sub_log2
      
        var $inv_sub_id {
          value = `$input.data.object.subscription`
        }
      
        conditional {
          if ($inv_sub_id != null) {
            db.query memberships {
              where = $db.memberships.stripe_subscription_id == `$var.inv_sub_id`
              return = {type: "list"}
            } as $inv_memberships
          
            conditional {
              if (($inv_memberships|count) > 0) {
                var $inv_membership {
                  value = `$var.inv_memberships|first`
                }
              
                var $inv_renewal {
                  value = `$input.data.object.period_end|multiply:1000`
                }
              
                db.edit memberships {
                  field_name = "id"
                  field_value = `$var.inv_membership.id`
                  enforce_hidden_fields = false
                  data = {status: "active", renewal_date: `$var.inv_renewal`}
                } as $inv_mem_update
              
                db.edit providers {
                  field_name = "id"
                  field_value = `$var.inv_membership.provider_id`
                  enforce_hidden_fields = false
                  data = {medical_director_status: "active"}
                } as $inv_prov_update
              }
            }
          }
        }
      }
    }
  
    // --- invoice.payment_failed -> past_due (gate trips) ---
    conditional {
      if ($input.type == "invoice.payment_failed") {
        db.edit webhook_log {
          field_name = "id"
          field_value = `$var.log_row.id`
          enforce_hidden_fields = false
          data = {processed: true}
        } as $sub_log3
      
        var $invf_sub_id {
          value = `$input.data.object.subscription`
        }
      
        conditional {
          if ($invf_sub_id != null) {
            db.query memberships {
              where = $db.memberships.stripe_subscription_id == `$var.invf_sub_id`
              return = {type: "list"}
            } as $invf_memberships
          
            conditional {
              if (($invf_memberships|count) > 0) {
                var $invf_membership {
                  value = `$var.invf_memberships|first`
                }
              
                db.edit memberships {
                  field_name = "id"
                  field_value = `$var.invf_membership.id`
                  enforce_hidden_fields = false
                  data = {status: "past_due"}
                } as $invf_mem_update
              
                db.edit providers {
                  field_name = "id"
                  field_value = `$var.invf_membership.provider_id`
                  enforce_hidden_fields = false
                  data = {medical_director_status: "past_due"}
                } as $invf_prov_update
              }
            }
          }
        }
      }
    }
  
    // --- customer.subscription.deleted -> cancelled (gate trips; provider -> inactive) ---
    conditional {
      if ($input.type == "customer.subscription.deleted") {
        db.edit webhook_log {
          field_name = "id"
          field_value = `$var.log_row.id`
          enforce_hidden_fields = false
          data = {processed: true}
        } as $sub_log4
      
        var $del_sub_id {
          value = `$input.data.object.id`
        }
      
        db.query memberships {
          where = $db.memberships.stripe_subscription_id == `$var.del_sub_id`
          return = {type: "list"}
        } as $del_memberships
      
        conditional {
          if (($del_memberships|count) > 0) {
            var $del_membership {
              value = `$var.del_memberships|first`
            }
          
            db.edit memberships {
              field_name = "id"
              field_value = `$var.del_membership.id`
              enforce_hidden_fields = false
              data = {status: "cancelled", cancel_date: `now`}
            } as $del_mem_update
          
            db.edit providers {
              field_name = "id"
              field_value = `$var.del_membership.provider_id`
              enforce_hidden_fields = false
              data = {medical_director_status: "inactive"}
            } as $del_prov_update
          }
        }
      }
    }
  
    conditional {
      if ($input.type == "charge.refunded") {
        db.edit webhook_log {
          field_name = "id"
          field_value = `$var.log_row.id`
          enforce_hidden_fields = false
          data = {processed: true}
        } as $webhook_log_refund
      
        var $rf_pi {
          value = `$input.data.object.payment_intent`
        }
      
        // 2026-07-07 fix: this Stripe API version's charge object has NO embedded refunds
        // list (refunds.data.0.amount resolved null -> amounts never moved). Use cumulative
        // amount_refunded instead. Idempotency: only recompute while the matching paid-flag
        // is still true (first delivery clears it on full refund; retries then skip).
        db.query training_enrollments {
          where = $db.training_enrollments.stripe_deposit_payment_intent_id == `$var.rf_pi` || $db.training_enrollments.stripe_balance_payment_intent_id == `$var.rf_pi`
          return = {type: "list"}
        } as $rf_matches
      
        conditional {
          if (($rf_matches|count) > 0) {
            var $rf_enr {
              value = `$var.rf_matches|first`
            }
          
            db.get training_courses {
              field_name = "id"
              field_value = `$var.rf_enr.training_course_id`
            } as $rf_course
          
            var $rf_isdep {
              value = `false`
            }
          
            conditional {
              if ($rf_enr.stripe_deposit_payment_intent_id == $rf_pi && $rf_enr.deposit_paid) {
                var.update $rf_isdep {
                  value = `true`
                }
              }
            }
          
            var $rf_isbal {
              value = `false`
            }
          
            conditional {
              if ($rf_enr.stripe_balance_payment_intent_id == $rf_pi && $rf_enr.balance_paid) {
                var.update $rf_isbal {
                  value = `true`
                }
              }
            }
          
            conditional {
              if ($rf_isdep || $rf_isbal) {
                var $rf_delta {
                  value = `$input.data.object.amount_refunded|divide:100`
                }
              
                var $rf_paid {
                  value = `$var.rf_enr.amount_paid|subtract:$var.rf_delta`
                }
              
                conditional {
                  if ($rf_paid < 0) {
                    var.update $rf_paid {
                      value = `0`
                    }
                  }
                }
              
                var $rf_bal {
                  value = `$var.rf_course.total_price|subtract:$var.rf_paid`
                }
              
                conditional {
                  if ($rf_bal < 0) {
                    var.update $rf_bal {
                      value = `0`
                    }
                  }
                }
              
                var $rf_status {
                  value = "partial"
                }
              
                conditional {
                  if ($rf_bal == 0) {
                    var.update $rf_status {
                      value = "paid_in_full"
                    }
                  }
                }
              
                conditional {
                  if ($rf_paid == 0) {
                    var.update $rf_status {
                      value = "unpaid"
                    }
                  }
                }
              
                var $rf_full {
                  value = `false`
                }
              
                conditional {
                  if ($input.data.object.amount == $input.data.object.amount_refunded) {
                    var.update $rf_full {
                      value = `true`
                    }
                  }
                }
              
                var $rf_depflag {
                  value = `$var.rf_enr.deposit_paid`
                }
              
                conditional {
                  if ($rf_isdep && $rf_full) {
                    var.update $rf_depflag {
                      value = `false`
                    }
                  }
                }
              
                var $rf_balflag {
                  value = `$var.rf_enr.balance_paid`
                }
              
                conditional {
                  if ($rf_isbal && $rf_full) {
                    var.update $rf_balflag {
                      value = `false`
                    }
                  }
                }
              
                conditional {
                  if ($rf_bal > 0) {
                    var.update $rf_balflag {
                      value = `false`
                    }
                  }
                }
              
                db.edit training_enrollments {
                  field_name = "id"
                  field_value = `$var.rf_enr.id`
                  enforce_hidden_fields = false
                  data = {
                    amount_paid   : `$var.rf_paid`
                    balance_due   : `$var.rf_bal`
                    payment_status: `$var.rf_status`
                    deposit_paid  : `$var.rf_depflag`
                    balance_paid  : `$var.rf_balflag`
                  }
                } as $rf_upd
              }
            }
          }
        }
      }
    }
  }

  response = {received: true}
}