// FET-01 — per-instance line-item balances, SNAPSHOTTED from the template at purchase
// (so later template edits never rewrite a sold package). qty_used is the per-line
// "sessions used" counter Phase 3's atomic decrement targets.
// Composite unique (client_package_id, service_id) mirrors the template rule.
table client_package_items {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid client_package_id? {
      table = "client_packages"
    }
  
    uuid service_id? {
      table = "services"
    }
  
    decimal per_session_value?="0.00"
    int qty_total?=1
    int qty_used?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {
      type : "btree|unique"
      field: [
        {name: "client_package_id", op: "asc"}
        {name: "service_id", op: "asc"}
      ]
    }
    {
      type : "btree"
      field: [{name: "client_package_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "service_id", op: "asc"}]}
  ]
}