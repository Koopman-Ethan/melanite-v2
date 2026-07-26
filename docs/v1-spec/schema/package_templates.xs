// FET-01 Packages — a provider's package catalog entry (the thing they sell).
// Additive; nothing live references it. Soft-delete via active=false, never hard-delete
// (purchase history will reference templates from Phase 2 on).
table package_templates {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid provider_id? {
      table = "providers"
    }
  
    text name? filters=trim
    text? description? filters=trim
    decimal total_price?="0.00"
    int? expires_after_days?
    bool active?=true
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {type: "btree", field: [{name: "active", op: "asc"}]}
  ]
}