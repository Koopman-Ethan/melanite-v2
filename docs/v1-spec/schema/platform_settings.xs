// Singleton config row for fee/commission rates and platform metadata.
table platform_settings {
  auth = false

  schema {
    int id
    timestamp created_at?=now {
      visibility = "private"
    }
  
    decimal provider_share_pct?="0.500"
    decimal tip_to_provider_pct?="1.000"
    decimal noshow_fee_pct_of_price?="0.500"
    decimal cancellation_fee_amount?="50.00"
    text stripe_platform_account_id filters=trim
    timestamp updated_at?=now
    uuid? updated_by? {
      table = "providers"
    }
  
    text laser_open_time?="08:00" filters=trim
    text laser_close_time?="20:00" filters=trim
    int slot_stride_mins?=15
    text? medical_director_price_id? filters=trim
    bool room_rental_enabled?
    bool packages_enabled?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]
}