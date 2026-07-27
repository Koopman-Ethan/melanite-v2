query "providers/me/acknowledge-policy" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: `$auth.id`}
    } as $provider
  
    db.edit providers {
      field_name = "id"
      field_value = `$var.provider.id`
      enforce_hidden_fields = false
      data = {
        policy_ack_at     : `now`
        policy_ack_version: "2026-07-06.v1"
      }
    } as $updated
  }

  response = {
    policy_ack_at     : `$var.updated.policy_ack_at`
    policy_ack_version: `$var.updated.policy_ack_version`
  }
}