// Immutable money ledger. One row per completed payment. Splits computed from platform_settings.provider_share_pct at write time and persisted. Append-only.
table transactions {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid provider_id? {
      table = "providers"
    }
  
    uuid booking_id? {
      table = "bookings"
    }
  
    uuid? checkout_link_id? {
      table = "checkout_links"
    }
  
    enum source?=booking {
      values = ["booking"]
    }
  
    decimal gross_amount?
    decimal tip_amount?="0.00"
    decimal provider_payout?
    decimal melanite_cut?
    text stripe_payment_intent_id? filters=trim
    text? stripe_transfer_id? filters=trim
    enum payout_status?=pending {
      values = ["pending", "paid", "failed"]
    }
  
    date? payout_date?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {
      type : "btree"
      field: [
        {name: "provider_id", op: "asc"}
        {name: "created_at", op: "desc"}
      ]
    }
    {type: "btree", field: [{name: "booking_id", op: "asc"}]}
    {
      type : "btree"
      field: [{name: "stripe_payment_intent_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "payout_status", op: "asc"}]}
  ]
}