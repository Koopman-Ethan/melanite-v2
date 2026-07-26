// Core appointment record for the single shared laser. Availability is GLOBAL: any provider's booking blocks the slot platform-wide.
table bookings {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid provider_id? {
      table = "providers"
    }
  
    uuid provider_service_id? {
      table = "provider_services"
    }
  
    text client_name? filters=trim
    text client_phone? filters=trim
    text? treatment_area? filters=trim
    decimal price?
    int duration_mins?
    timestamp start_time?
    timestamp end_time?
    enum status?=upcoming {
      values = ["upcoming", "completed", "cancelled", "no_show"]
    }
  
    text? google_calendar_event_id? filters=trim
    text? notes?
    text? client_email? filters=trim
  
    // List/service price before discount
    decimal original_price?
  
    // Percent off applied by provider (e.g. 10 = 10%)
    decimal discount_pct?
  
    timestamp? policy_ack_at?
    text? policy_ack_version? filters=trim
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}]}
    {type: "btree", field: [{name: "start_time", op: "asc"}]}
    {
      type : "btree"
      field: [
        {name: "start_time", op: "asc"}
        {name: "end_time", op: "asc"}
      ]
    }
  ]
}