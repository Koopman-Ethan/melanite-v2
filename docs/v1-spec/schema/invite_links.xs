// Admin-issued provider invites consumed during onboarding.
table invite_links {
  auth = false

  schema {
    uuid id
    timestamp created_at?=now {
      visibility = "private"
    }
  
    // Email that the invite was sent to.
    email email filters=trim|lower
  
    // Provider who sent the invite.
    uuid invited_by_admin_id {
      table = "providers"
    }
  
    text token filters=trim
  
    // Status of the invite
    enum status?=pending {
      values = ["pending", "accepted", "expired"]
    }
  
    // When the link was sent.
    timestamp sent_at
  
    // The time the link expires
    timestamp expires_at
  
    // Time the link was accepted.
    timestamp? accepted_at?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree|unique", field: [{name: "token", op: "asc"}]}
    {type: "btree", field: [{name: "email", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}]}
  ]
}