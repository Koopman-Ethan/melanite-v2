// POST /bookings/create — provider JWT. Spec 3.2.2. The critical atomic write.
// Gate (provider active + medical_director_status active) -> validate service/price/duration/time ->
// GLOBAL collision check inside a transaction -> insert booking + checkout_link (token, expires +7d).
// Error codes (CODE: prefix convention): MEDICAL_DIRECTOR_REQUIRED (403, message carries pay_url),
// INVALID_SERVICE, INVALID_PRICE, DURATION_OUT_OF_RANGE, START_TIME_IN_PAST, OUTSIDE_OPERATING_HOURS, SLOT_TAKEN.
query "bookings/create" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text provider_service_id filters=trim
    text client_name filters=trim
    text client_phone filters=trim
    text? treatment_area? filters=trim
    timestamp start_time
    text? notes?
    decimal? discount_pct?
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
  
    var $ps_id {
      value = `$input.provider_service_id`
    }
  
    db.get provider_services {
      field_name = "id"
      field_value = `$var.ps_id`
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
  
    precondition ($ps.price > 0) {
      error_type = "badrequest"
      error = "INVALID_PRICE: Service price must be greater than zero."
    }
  
    precondition ($ps.duration_mins >= $service.min_duration_mins && $ps.duration_mins <= $service.max_duration_mins) {
      error_type = "badrequest"
      error = "DURATION_OUT_OF_RANGE: Configured duration is outside the service limits."
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
  
    security.create_uuid as $tok1
    security.create_uuid as $tok2
    var $token {
      value = `$var.tok1|concat:$var.tok2:"-"`
    }
  
    var $expires_at {
      value = `now|add_secs_to_timestamp:604800`
    }
  
    var $discount_pct {
      value = `$input.discount_pct|first_notnull:0`
    }
  
    precondition ($discount_pct >= 0 && $discount_pct < 100) {
      error_type = "badrequest"
      error = "INVALID_DISCOUNT: discount_pct must be at least 0 and less than 100."
    }
  
    var $original_price {
      value = `$var.ps.price`
    }
  
    var $discount_amount {
      value = `$var.original_price|multiply:$var.discount_pct|divide:100`
    }
  
    var $charge_price {
      value = `$var.original_price|subtract:$var.discount_amount|round:2`
    }
  
    precondition ($charge_price >= 0.5) {
      error_type = "badrequest"
      error = "INVALID_DISCOUNT: Discounted price must be at least $0.50."
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
      
        db.add bookings {
          enforce_hidden_fields = false
          data = {
            provider_id        : `$var.provider.id`
            provider_service_id: `$var.ps.id`
            client_name        : `$input.client_name`
            client_phone       : `$input.client_phone`
            treatment_area     : `$input.treatment_area`
            price              : `$var.charge_price`
            original_price     : `$var.original_price`
            discount_pct       : `$var.discount_pct`
            duration_mins      : `$var.ps.duration_mins`
            start_time         : `$input.start_time`
            end_time           : `$var.end_time`
            status             : "upcoming"
            notes              : `$input.notes`
          }
        } as $booking
      
        db.add checkout_links {
          enforce_hidden_fields = false
          data = {
            booking_id: `$var.booking.id`
            token     : `$var.token`
            status    : "pending"
            expires_at: `$var.expires_at`
          }
        } as $checkout_link
      }
    }
  
    var $pay_url {
      value = `$env.APP_BASE_URL|concat:"/pay/"|concat:$var.token`
    }
  
    var $checkout_link_response {
      value = `{}|set:"id":$var.checkout_link.id|set:"token":$var.token|set:"url":$var.pay_url|set:"expires_at":$var.expires_at`
    }
  }

  response = {
    booking      : `$var.booking`
    checkout_link: `$var.checkout_link_response`
  }
}