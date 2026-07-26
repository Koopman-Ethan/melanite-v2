// FET-01 Phase 2 — package money ledger, SEPARATE from the live transactions table
// (D1, the room_transactions precedent: the laser ledger stays clean and untouched).
// Append-only, immutable — rows are never edited. Split computed from
// platform_settings.provider_share_pct at write time and PERSISTED (authoritative).
// payout_status/payout_date = shape parity with transactions; the Connect payout
// sweep does NOT cover this table yet (reporting phase decision).
// type=refund rows are for the future refund SOP; stripe_refund_id from day one (FUP-13).
table package_transactions {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid provider_id? {
      table = "providers"
    }
  
    uuid package_checkout_link_id? {
      table = "package_checkout_links"
    }
  
    uuid package_template_id? {
      table = "package_templates"
    }
  
    enum type?=purchase {
      values = ["purchase", "refund"]
    }
  
    decimal gross_amount?="0.00"
    decimal tip_amount?="0.00"
    decimal provider_payout?="0.00"
    decimal melanite_cut?="0.00"
    text stripe_payment_intent_id? filters=trim
    text? stripe_refund_id? filters=trim
    enum payout_status?=pending {
      values = ["pending", "paid", "failed"]
    }
  
    date? payout_date?
    text? note? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {
      type : "btree"
      field: [{name: "package_checkout_link_id", op: "asc"}]
    }
    {
      type : "btree"
      field: [{name: "stripe_payment_intent_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]
}