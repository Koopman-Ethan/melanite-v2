table training_enrollments {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now {
      visibility = "private"
    }
  
    uuid training_course_id? {
      table = "training_courses"
    }
  
    uuid? provider_id? {
      table = "providers"
    }
  
    uuid? invite_link_id? {
      table = "invite_links"
    }
  
    text first_name? filters=trim
    text last_name? filters=trim
    email email? filters=trim|lower
    text? phone? filters=trim
    text? license_number? filters=trim
    bool deposit_paid?
    decimal deposit_amount?
    text? stripe_deposit_payment_intent_id? filters=trim
    bool balance_paid?
    text? stripe_balance_payment_intent_id? filters=trim
    timestamp? course_completed_at?
    decimal amount_paid?
    decimal balance_due?
    enum payment_status? {
      values = ["unpaid", "partial", "paid_in_full"]
    }
  
    date? balance_due_date?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {
      type : "btree"
      field: [{name: "training_course_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "email", op: "asc"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
  ]
}