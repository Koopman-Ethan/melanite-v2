// FET-05 Daily Room Rental — one row per rental block. Additive; nothing live references it.
// active_slot_key = "<rental_date>:<slot_type>" while status=confirmed, null otherwise —
// partial-unique-index workaround (NULLs don't collide on the unique index).
table room_bookings {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid provider_id? {
      table = "providers"
    }
  
    date rental_date?
    enum slot_type?=full {
      values = ["full", "am", "pm"]
    }
  
    decimal price?="0.00"
    enum status?=confirmed {
      values = ["confirmed", "cancelled", "cancellation_requested", "refunded"]
    }
  
    text stripe_payment_intent_id? filters=trim
    timestamp start_at?
    timestamp end_at?
    timestamp? cancelled_at?
    text? active_slot_key? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {
      type : "btree|unique"
      field: [{name: "active_slot_key", op: "asc"}]
    }
    {type: "btree", field: [{name: "rental_date", op: "asc"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}]}
    {
      type : "btree"
      field: [{name: "stripe_payment_intent_id", op: "asc"}]
    }
  ]
}