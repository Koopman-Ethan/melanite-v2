table webhook_log {
  auth = false

  schema {
    int id
    timestamp created_at?=now {
      visibility = "private"
    }
  
    text destination? filters=trim
    text? event_type? filters=trim
    text? event_id? filters=trim
    text raw_payload? filters=trim
    json headers?
    bool verify_passed?
    bool processed?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]
}