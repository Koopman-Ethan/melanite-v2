// POST /bookings/{booking_id}/mark-no-show — provider JWT. Spec 3.2.4.
// Label a PAST upcoming booking as no_show. STATUS LABEL ONLY — no fee is charged (no-show
// charges are deferred to Phase 3 per locked decision).
query "bookings/{booking_id}/mark-no-show" verb=POST {
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
      error = "CANNOT_MARK_NO_SHOW: Only upcoming bookings can be marked as a no-show."
    }
  
    precondition ($booking.start_time < now) {
      error_type = "badrequest"
      error = "BOOKING_NOT_PAST: You can only mark a no-show after the appointment start time."
    }
  
    db.edit bookings {
      field_name = "id"
      field_value = `$var.bk_id`
      enforce_hidden_fields = false
      data = {status: "no_show"}
    } as $updated_booking
  }

  response = {booking: `$var.updated_booking`}
}