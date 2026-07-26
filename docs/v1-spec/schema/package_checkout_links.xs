// FET-01 Phase 2 — package purchase links, the package-mode mirror of checkout_links
// (which is 1:1 with a booking and can't be reused). Token-auth public checkout;
// unpaid links expire after 7 days (expires_at set at insert).
// WIPE RULE: every db.edit on this table writes the FULL row.
// stripe_customer_id ships for card-on-file later; nothing writes it in Phase 2.
table package_checkout_links {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    text token? filters=trim
    uuid package_template_id? {
      table = "package_templates"
    }
  
    uuid provider_id? {
      table = "providers"
    }
  
    text? client_email? filters=trim|lower
    enum status?=pending {
      values = ["pending", "paid", "expired", "cancelled"]
    }
  
    decimal tip_amount?="0.00"
    text? stripe_customer_id? filters=trim
    text? stripe_payment_intent_id? filters=trim
    timestamp? paid_at?
    timestamp expires_at?
    text? client_name? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "token", op: "asc"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}]}
    {
      type : "btree"
      field: [{name: "stripe_payment_intent_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]
}