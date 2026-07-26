// GET /room/my-rentals — FET-05. The provider's own rentals (all statuses);
// frontend splits upcoming/past on start_at.
query "room/my-rentals" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query room_bookings {
      where = $db.room_bookings.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $rentals
  }

  response = {rentals: `$var.rentals`}
}