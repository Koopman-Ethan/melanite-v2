// GET /room/availability — FET-05. Confirmed rental blocks in [from, to] for the calendar.
// No feature-flag gate on reads (harmless + needed for dark testing); auth'd providers only.
query "room/availability" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text from filters=trim
    text to filters=trim
  }

  stack {
    db.query room_bookings {
      where = $db.room_bookings.rental_date >= `$input.from` && $db.room_bookings.rental_date <= `$input.to` && $db.room_bookings.status == "confirmed"
      return = {type: "list"}
    } as $blocks
  }

  response = {blocks: `$var.blocks`}
}