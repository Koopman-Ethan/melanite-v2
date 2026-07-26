// FET-01 — line items on a template: {service, quantity, per_session_value}.
// service_id points at the MASTER services catalog; eligibility (provider offers it)
// is enforced in the endpoints against provider_services.
// Composite unique (package_template_id, service_id) = one line per service per template.
table package_template_items {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid package_template_id? {
      table = "package_templates"
    }
  
    uuid service_id? {
      table = "services"
    }
  
    int quantity?=1
    decimal per_session_value?="0.00"
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {
      type : "btree|unique"
      field: [
        {name: "package_template_id", op: "asc"}
        {name: "service_id", op: "asc"}
      ]
    }
    {
      type : "btree"
      field: [{name: "package_template_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "service_id", op: "asc"}]}
  ]
}