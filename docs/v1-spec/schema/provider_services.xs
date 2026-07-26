// Per-provider service config — links a provider to a service with their custom price, duration, and on/off toggle.
table provider_services {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now {
      visibility = "private"
    }
  
    uuid provider_id {
      table = "providers"
    }
  
    uuid service_id {
      table = "services"
    }
  
    // The price that the provider charges for said service.
    decimal price
  
    int duration_mins
  
    // Provider's own on/off toggle
    bool is_active?=true
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {
      type : "btree|unique"
      field: [
        {name: "provider_id", op: "asc"}
        {name: "service_id", op: "asc"}
      ]
    }
    {type: "btree", field: [{name: "is_active", op: "asc"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
  ]
}