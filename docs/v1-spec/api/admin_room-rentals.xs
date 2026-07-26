// GET /admin/room-rentals — FET-05. Admin-only (is_admin; MD deliberately excluded per
// FET-15 — MD is appointment-calendar-only). All rentals + the <=24h review queue.
query "admin/room-rentals" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition ($provider.is_admin) {
      error_type = "accessdenied"
      error = "ADMIN_ONLY: You do not have access to this resource."
    }
  
    db.query room_bookings {
      return = {type: "list"}
    } as $rentals
  
    db.query room_bookings {
      where = $db.room_bookings.status == "cancellation_requested"
      return = {type: "list"}
    } as $review_queue
  }

  response = {
    rentals     : `$var.rentals`
    review_queue: `$var.review_queue`
  }
}