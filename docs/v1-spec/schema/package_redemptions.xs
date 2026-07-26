// FET-01 — immutable redemption ledger: one row per session consumed.
// overall_index / service_index power the "Session 3 of 6 · Laser 2 of 3" display.
// Append-only, like transactions. booking_id links the $0 redemption booking.
table package_redemptions {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now
    uuid client_package_id? {
      table = "client_packages"
    }
  
    uuid client_package_item_id? {
      table = "client_package_items"
    }
  
    uuid booking_id? {
      table = "bookings"
    }
  
    int overall_index?
    int service_index?
    timestamp? redeemed_at?
  
    // FET-01 Piece 3. Null = the redemption stands. Set = the booking was cancelled and the session was restored to the package; the row is kept for audit but must be excluded from balance math and shown without a session index (its overall_index can be reissued to a later redemption).
    timestamp? voided_at?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {
      type : "btree"
      field: [{name: "client_package_id", op: "asc"}]
    }
    {
      type : "btree"
      field: [{name: "client_package_item_id", op: "asc"}]
    }
    {type: "btree", field: [{name: "booking_id", op: "asc"}]}
  ]
}