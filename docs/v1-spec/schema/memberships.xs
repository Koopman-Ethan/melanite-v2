table memberships {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid provider_id? {
      table = "providers"
    }
  
    enum plan_type?="medical_director" {
      values = ["medical_director"]
    }
  
    text? stripe_subscription_id? filters=trim
    text? stripe_customer_id? filters=trim
    enum status?=active {
      values = ["active", "past_due", "cancelled"]
    }
  
    bool cancel_at_period_end?
    timestamp? start_date?
    timestamp? renewal_date?
    timestamp? cancel_date?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {
      type : "btree|unique"
      field: [{name: "stripe_subscription_id", op: "asc"}]
    }
  ]
}