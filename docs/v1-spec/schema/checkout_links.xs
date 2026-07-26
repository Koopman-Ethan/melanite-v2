// One-to-one with bookings; token-authenticated public checkout link. Unpaid links expire after 7 days (expires_at set at insert).
table checkout_links {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid booking_id? {
      table = "bookings"
    }
  
    text token? filters=trim
    enum status?=pending {
      values = ["pending", "paid", "expired", "cancelled"]
    }
  
    decimal tip_amount?="0.00"
    text? stripe_customer_id? filters=trim
    text? stripe_payment_intent_id? filters=trim
    timestamp? paid_at?
    timestamp expires_at?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree|unique", field: [{name: "token", op: "asc"}]}
    {
      type : "btree|unique"
      field: [{name: "booking_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "status", op: "asc"}]}
    {
      type : "btree"
      field: [{name: "stripe_payment_intent_id", op: "asc"}]
    }
  ]
}