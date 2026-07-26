table training_courses {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now {
      visibility = "private"
    }
  
    date day1_date?
    text day1_start?="10:00" filters=trim
    text day1_end?="16:00" filters=trim
    date day2_date?
    text day2_start?="10:00" filters=trim
    text day2_end?="14:00" filters=trim
    int max_students?=5
    decimal deposit_amount?="500.00"
    decimal total_price?="1400.00"
    text? google_calendar_event_id_day1? filters=trim
    text? google_calendar_event_id_day2? filters=trim
    enum status?=scheduled {
      values = ["scheduled", "completed", "cancelled"]
    }
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}]}
    {type: "btree", field: [{name: "day1_date", op: "asc"}]}
  ]
}