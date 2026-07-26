// FET-05 — rental payment ledger, kept separate from the laser transactions table
// so laser revenue reporting stays clean and un-split. Append-only.
// room_booking_id is NULLABLE: a double-book auto-refund has no booking row.
table room_transactions {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid? room_booking_id? {
      table = "room_bookings"
    }
  
    uuid provider_id? {
      table = "providers"
    }
  
    decimal amount?="0.00"
    enum type?=rental {
      values = ["rental", "refund"]
    }
  
    text stripe_payment_intent_id? filters=trim
    text? stripe_refund_id? filters=trim
    text? note? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {
      type : "btree"
      field: [{name: "room_booking_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {
      type : "btree"
      field: [{name: "stripe_payment_intent_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]
}