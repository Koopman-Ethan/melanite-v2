// Powers the forgot/reset-password flow (spec §2.10). One row per reset request.
// token = two concatenated UUIDs (≥32 char, unique). expires_at = now + 1h.
// status lifecycle: pending -> used (on successful reset) or expired (hourly cron / just-in-time at reset).
table password_reset_tokens {
  auth = false

  schema {
    uuid id
  
    // When the reset link was issued.
    timestamp sent_at?=now
  
    // Owner of this reset token.
    uuid provider_id? {
      table = "providers"
    }
  
    // The random reset token embedded in the /auth/reset?token= link.
    text token? filters=trim
  
    enum status?=pending {
      values = ["pending", "used", "expired"]
    }
  
    // now + 1h at insert.
    timestamp expires_at?
  
    // Stamped when the token is consumed by a successful reset.
    timestamp? used_at?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "token", op: "asc"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
  ]
}