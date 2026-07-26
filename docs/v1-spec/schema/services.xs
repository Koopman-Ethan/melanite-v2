// Master catalog of treatments offered platform-wide
table services {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now {
      visibility = "private"
    }
  
    // name of the service
    text name filters=trim
  
    // Descriptionof the service 
    text? description? filters=trim
  
    // Suggested amount of time for service
    int suggested_duration_mins
  
    // Minimum amount of time for service
    int min_duration_mins
  
    // Max amount of time for service
    int max_duration_mins
  
    // Determines if a service is package eligible.
    bool package_eligible
  
    // Designates whether the service is active to be offered by providers.
    bool active?=true
  
    // A future-proofing flag for ablative laser services — the kind that physically remove a layer of skin (CO2 resurfacing, Erbium, etc.) and require more advanced training than the standard RN/NP/PA license.
    bool advanced_tier_required
  
    text? color_hex? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "active", op: "asc"}]}
  ]
}