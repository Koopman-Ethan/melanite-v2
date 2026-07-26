// FET-01 — a purchased package instance. Phase 2's webhook creates rows here on
// successful payment; Phase 1 only creates the table. purchase_transaction_id is
// nullable (webhook fills it). client_email is the client identity for now
// (no client accounts); Phase 2's card-on-file work may add a Customer link later.
table client_packages {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid provider_id? {
      table = "providers"
    }
  
    text client_email? filters=trim|lower
    uuid package_template_id? {
      table = "package_templates"
    }
  
    uuid? purchase_transaction_id? {
      table = "package_transactions"
    }
  
    enum status?=active {
      values = ["active", "exhausted", "expired", "refunded"]
    }
  
    timestamp? purchased_at?
    timestamp? expires_at?
    text? client_name? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {type: "btree", field: [{name: "client_email", op: "asc"}]}
    {
      type : "btree"
      field: [{name: "package_template_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "status", op: "asc"}]}
  ]
}