//  POST /bookings/create-from-package — FET-01 Phase 3. The parallel twin of the
//  live bookings/create #3933580 (danger-list: never edited). Creates a $0
//  redemption booking against a client_packages balance:
//    provider gates (VERBATIM from live: active -> MD active -> booking_enabled
//    -> license) -> package validation (exists -> caller's -> client_email match
//    (D3) -> JIT expiry flip (FULL-ROW, wipe rule) -> status active) -> service
//    validation (mirrors live, minus price/discount — D5) -> line-item match on
//    ps.service_id (SERVICE_NOT_IN_PACKAGE) -> time validation -> db.transaction {
//    GLOBAL collision check -> RE-READ the line item -> qty_used < qty_total
//    (NO_SESSIONS_REMAINING) -> compute overall_index + service_index in-txn ->
//    db.add bookings (price 0, original_price = per_session_value, discount_pct 0,
//    client_email set, NO checkout_link) -> db.add package_redemptions ->
//    FULL-ROW decrement of client_package_items -> all lines full? FULL-ROW flip
//    client_packages to exhausted }.
//  REDEMPTIONS MOVE NO MONEY — zero Stripe calls; the split settled at purchase.
//  NOT gated on packages_enabled (D2): paid value must always be redeemable.
//  NO credit restore anywhere (D4 — Q-03 pending; manual SOP only).
//  2026-07-24 HOTFIX: both client_packages full-row edits (the JIT expiry flip
//  and the exhausted flip) now carry client_name. Part D added that nullable
//  column AFTER this endpoint was authored, so omitting it wiped the client's
//  name — on the exhausted flip that meant losing it on the LAST redemption.
// 
//  2026-07-25 — FET-01 Phase 5 (spec step 6): sends the client an appointment
//  confirmation carrying both session indices and the remaining balance. There was
//  NO email on this path before — a paid booking gets its receipt from the platform
//  webhook's booking_payment branch, which fires off the PAYMENT, and a redemption
//  has no payment. So a client redeeming a prepaid session previously received
//  nothing at all. Placed OUTSIDE the db.transaction (everything is committed first)
//  and guarded on RESEND_API_KEY; api.request never fails the stack, so a Resend
//  outage cannot turn a successful redemption into an error for the provider.
query "bookings/create-from-package" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text client_package_id filters=trim
    text provider_service_id filters=trim
    text client_name filters=trim
    text client_phone filters=trim
    text client_email filters=trim|lower
    text? treatment_area? filters=trim
    timestamp start_time
    text? notes?
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition ($provider.status == "active") {
      error_type = "accessdenied"
      error = "PROVIDER_NOT_ACTIVE: Your account must be active to book laser time."
    }
  
    precondition ($provider.medical_director_status == "active") {
      error_type = "accessdenied"
      error = "MEDICAL_DIRECTOR_REQUIRED: An active medical director is required before booking. pay_url=/app/medical-director"
    }
  
    precondition ($provider.booking_enabled) {
      error_type = "accessdenied"
      error = "BOOKING_NOT_ENABLED: Your account isn't approved for booking yet. Keoni will enable booking once your required documents are confirmed."
    }
  
    precondition ($provider.license_expiry >= (now|format_timestamp:"Y-m-d":"America/Denver") || $provider.license_expiry == null) {
      error_type = "accessdenied"
      error = "LICENSE_EXPIRED: Your professional license has expired. Please renew it and contact Keoni to update your record before booking."
    }
  
    precondition (($input.client_email|strlen) > 0) {
      error_type = "badrequest"
      error = "CLIENT_EMAIL_REQUIRED: The client's email is required to redeem from a package."
    }
  
    db.get client_packages {
      field_name = "id"
      field_value = `$input.client_package_id`
    } as $pkg
  
    precondition ($pkg != null) {
      error_type = "notfound"
      error = "PACKAGE_NOT_FOUND: That package does not exist."
    }
  
    precondition ($pkg.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "PACKAGE_NOT_FOUND: That package does not belong to you."
    }
  
    var $pkg_email {
      value = `$var.pkg.client_email|trim|to_lower`
    }
  
    var $in_email {
      value = `$input.client_email|trim|to_lower`
    }
  
    precondition ($pkg_email == $in_email) {
      error_type = "badrequest"
      error = "CLIENT_EMAIL_MISMATCH: That email does not match the client this package was sold to."
    }
  
    var $pkg_status {
      value = `$var.pkg.status`
    }
  
    conditional {
      if ($pkg.status == "active" && $pkg.expires_at != null && $pkg.expires_at < now) {
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
            status                 : "expired"
            purchased_at           : `$var.pkg.purchased_at`
            expires_at             : `$var.pkg.expires_at`
          }
        } as $pkg_expired
      
        var.update $pkg_status {
          value = "expired"
        }
      }
    }
  
    precondition ($pkg_status != "expired") {
      error_type = "badrequest"
      error = "PACKAGE_EXPIRED: This package has expired and can no longer be redeemed."
    }
  
    precondition ($pkg_status == "active") {
      error_type = "badrequest"
      error = "PACKAGE_NOT_ACTIVE: This package is not active (it may be exhausted or refunded)."
    }
  
    db.get provider_services {
      field_name = "id"
      field_value = `$input.provider_service_id`
    } as $ps
  
    precondition ($ps != null) {
      error_type = "notfound"
      error = "INVALID_SERVICE: That service configuration does not exist."
    }
  
    precondition ($ps.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "INVALID_SERVICE: That service does not belong to you."
    }
  
    precondition (`$var.ps.is_active`) {
      error_type = "badrequest"
      error = "INVALID_SERVICE: That service is not active on your profile."
    }
  
    db.get services {
      field_name = "id"
      field_value = `$var.ps.service_id`
    } as $service
  
    precondition (`$var.service.active`) {
      error_type = "badrequest"
      error = "INVALID_SERVICE: That service is not currently offered platform-wide."
    }
  
    precondition ($ps.duration_mins >= $service.min_duration_mins && $ps.duration_mins <= $service.max_duration_mins) {
      error_type = "badrequest"
      error = "DURATION_OUT_OF_RANGE: Configured duration is outside the service limits."
    }
  
    db.query client_package_items {
      where = $db.client_package_items.client_package_id == `$var.pkg.id` && $db.client_package_items.service_id == `$var.ps.service_id`
      return = {type: "list"}
    } as $match_items
  
    precondition (($match_items|count) > 0) {
      error_type = "badrequest"
      error = "SERVICE_NOT_IN_PACKAGE: This package does not include that service."
    }
  
    var $line_item {
      value = `$var.match_items|first`
    }
  
    precondition ($input.start_time > now) {
      error_type = "badrequest"
      error = "START_TIME_IN_PAST: start_time must be in the future."
    }
  
    db.get platform_settings {
      field_name = "id"
      field_value = 1
    } as $settings
  
    var $date_str {
      value = `$input.start_time|format_timestamp:"Y-m-d":"America/Denver"`
    }
  
    var $open_ts {
      value = `$var.date_str|concat:$var.settings.laser_open_time:" "|parse_timestamp:"Y-m-d H:i":"America/Denver"`
    }
  
    var $close_ts {
      value = `$var.date_str|concat:$var.settings.laser_close_time:" "|parse_timestamp:"Y-m-d H:i":"America/Denver"`
    }
  
    var $duration_secs {
      value = `$var.ps.duration_mins|multiply:60`
    }
  
    var $end_time {
      value = `$input.start_time|add_secs_to_timestamp:$var.duration_secs`
    }
  
    precondition ($input.start_time >= $open_ts && $end_time <= $close_ts) {
      error_type = "badrequest"
      error = "OUTSIDE_OPERATING_HOURS: The requested slot is outside laser operating hours."
    }
  
    db.transaction {
      stack {
        db.query bookings {
          where = $db.bookings.end_time > `$input.start_time` && $db.bookings.start_time < `$var.end_time` && ($db.bookings.status == "upcoming" || $db.bookings.status == "completed")
          return = {type: "count"}
        } as $collision_count
      
        precondition ($collision_count == 0) {
          error_type = "badrequest"
          error = "SLOT_TAKEN: That slot was just booked by another provider. Refresh availability and pick another time."
        }
      
        db.get client_package_items {
          field_name = "id"
          field_value = `$var.line_item.id`
        } as $item_fresh
      
        precondition ($item_fresh.qty_used < $item_fresh.qty_total) {
          error_type = "badrequest"
          error = "NO_SESSIONS_REMAINING: All sessions for this service in this package have been used."
        }
      
        db.query client_package_items {
          where = $db.client_package_items.client_package_id == `$var.pkg.id`
          return = {type: "list"}
        } as $all_items
      
        var $used_sum {
          value = `0`
        }
      
        var $total_sum {
          value = `0`
        }
      
        foreach ($all_items) {
          each as $ai {
            var.update $used_sum {
              value = `$var.used_sum|add:$ai.qty_used`
            }
          
            var.update $total_sum {
              value = `$var.total_sum|add:$ai.qty_total`
            }
          }
        }
      
        var $overall_index {
          value = `$var.used_sum|add:1`
        }
      
        var $service_index {
          value = `$var.item_fresh.qty_used|add:1`
        }
      
        var $new_qty_used {
          value = `$var.item_fresh.qty_used|add:1`
        }
      
        var $new_used_sum {
          value = `$var.used_sum|add:1`
        }
      
        db.add bookings {
          enforce_hidden_fields = false
          data = {
            provider_id        : `$var.provider.id`
            provider_service_id: `$var.ps.id`
            client_name        : `$input.client_name`
            client_phone       : `$input.client_phone`
            client_email       : `$var.in_email`
            treatment_area     : `$input.treatment_area`
            price              : 0
            original_price     : `$var.item_fresh.per_session_value`
            discount_pct       : 0
            duration_mins      : `$var.ps.duration_mins`
            start_time         : `$input.start_time`
            end_time           : `$var.end_time`
            status             : "upcoming"
            notes              : `$input.notes`
          }
        } as $booking
      
        db.add package_redemptions {
          enforce_hidden_fields = false
          data = {
            client_package_id     : `$var.pkg.id`
            client_package_item_id: `$var.item_fresh.id`
            booking_id            : `$var.booking.id`
            overall_index         : `$var.overall_index`
            service_index         : `$var.service_index`
            redeemed_at           : `now`
          }
        } as $redemption
      
        db.edit client_package_items {
          field_name = "id"
          field_value = `$var.item_fresh.id`
          enforce_hidden_fields = false
          data = {
            client_package_id: `$var.item_fresh.client_package_id`
            service_id       : `$var.item_fresh.service_id`
            per_session_value: `$var.item_fresh.per_session_value`
            qty_total        : `$var.item_fresh.qty_total`
            qty_used         : `$var.new_qty_used`
          }
        } as $item_updated
      
        conditional {
          if ($new_used_sum == $total_sum) {
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
                status                 : "exhausted"
                purchased_at           : `$var.pkg.purchased_at`
                expires_at             : `$var.pkg.expires_at`
              }
            } as $pkg_exhausted
          
            var.update $pkg_status {
              value = "exhausted"
            }
          }
        }
      }
    }
  
    var $line_remaining {
      value = `$var.item_fresh.qty_total|subtract:$var.new_qty_used`
    }
  
    var $redemption_summary {
      value = `{}|set:"redemption_id":$var.redemption.id|set:"client_package_id":$var.pkg.id|set:"overall_index":$var.overall_index|set:"service_index":$var.service_index|set:"sessions_total":$var.total_sum|set:"sessions_used":$var.new_used_sum|set:"line_remaining":$var.line_remaining|set:"package_status":$var.pkg_status`
    }
  
    // ---------- FET-01 Phase 5 (step 6): appointment confirmation + balance to the client ----
    // Outside the transaction — booking, ledger row and decrement are already committed.
    var $re_overall_remaining {
      value = `$var.total_sum|subtract:$var.new_used_sum`
    }
  
    var $re_when {
      value = `$input.start_time|format_timestamp:"D, M j, Y, g:i A":"America/Denver"`
    }
  
    var $re_provname {
      value = `$var.provider.first_name|concat:$var.provider.last_name:" "`
    }
  
    var $re_session_line {
      value = `"Session "|concat:$var.overall_index|concat:" of "|concat:$var.total_sum|concat:" &middot; "|concat:$var.service.name|concat:" "|concat:$var.service_index|concat:" of "|concat:$var.item_fresh.qty_total`
    }
  
    var $re_balance_line {
      value = `$var.line_remaining|concat:" of "|concat:$var.item_fresh.qty_total|concat:" "|concat:$var.service.name|concat:" sessions remaining"`
    }
  
    conditional {
      if ($env.RESEND_API_KEY != "" && $in_email != null && $in_email != "") {
        var $re_html {
          value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>Your appointment is booked</h2><p>This session is drawn from your prepaid package - there is nothing to pay at your visit.</p><table style='width:100%;border-collapse:collapse;margin:16px 0'><tr><td style='padding:6px 0;color:#777'>Service</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.service.name|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Provider</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.re_provname|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>When</td><td style='padding:6px 0;text-align:right;font-weight:bold'>"|concat:$var.re_when|concat:"</td></tr><tr><td style='padding:6px 0;color:#777'>Session</td><td style='padding:6px 0;text-align:right'>"|concat:$var.re_session_line|concat:"</td></tr><tr><td style='padding:10px 0 0;color:#1a1a1a;font-weight:bold;border-top:1px solid #e7e2d8'>Amount due</td><td style='padding:10px 0 0;text-align:right;font-weight:bold;color:#B8965A;border-top:1px solid #e7e2d8'>$0 - prepaid</td></tr></table><div style='margin-top:16px;padding:12px 14px;background:#faf8f4;border:1px solid #e7e2d8'><p style='margin:0 0 6px;color:#1a1a1a;font-weight:bold;font-size:13px'>Your package balance</p><p style='margin:0;color:#555;font-size:13px'>"|concat:$var.re_balance_line|concat:" &middot; "|concat:$var.re_overall_remaining|concat:" session(s) left in this package overall.</p></div><div style='margin-top:14px;padding:12px 14px;border:1px solid #e7e2d8'><p style='margin:0 0 6px;color:#1a1a1a;font-weight:bold;font-size:13px'>Need to reschedule?</p><p style='margin:0;color:#555;font-size:13px'>Contact your provider directly. Cancelling more than 24 hours ahead returns the session to your package. Cancellations within 24 hours, or no-shows, may forfeit the session at your provider's discretion.</p></div><p style='color:#999;font-size:12px'>Melanite Laser Suite, Boise, Idaho</p></div></div>"`
        }
      
        api.request {
          url = "https://api.resend.com/emails"
          method = "POST"
          params = {}
            |set:"from":`$env.RESEND_FROM`
            |set:"to":`$var.in_email`
            |set:"subject":"Your Melanite appointment is booked"
            |set:"html":`$var.re_html`
          headers = []
            |push:`"Authorization: Bearer "|concat:$env.RESEND_API_KEY`
            |push:"Content-Type: application/json"
        } as $re_email_response
      }
    }
  }

  response = {
    booking   : `$var.booking`
    redemption: `$var.redemption_summary`
  }
}