// POST /auth/reset-password — PUBLIC (token in body). Spec §3.5.3.
// Validate token: not found -> INVALID_RESET_TOKEN (notfound); used / expired / past expires_at -> RESET_TOKEN_EXPIRED (badrequest).
// Validate new_password length >= 12 (backend length-only; frontend enforces char classes — char-class regex never matches reliably in Xano).
// Update providers.password_hash (password-type field auto-bcrypts on write), mark token used + used_at=now,
// return a fresh JWT { token, provider } for auto-login — MIRRORS /auth/login (security.create_auth_token + provider|unset:password_hash).
query "auth/reset-password" verb=POST {
  api_group = "melanite_v1"

  input {
    text token filters=trim
    text new_password filters=trim {
      sensitive = true
    }
  }

  stack {
    var $token {
      value = `$input.token`
    }
  
    db.get password_reset_tokens {
      field_name = "token"
      field_value = `$var.token`
    } as $reset_token
  
    precondition ($reset_token != null) {
      error_type = "notfound"
      error = "INVALID_RESET_TOKEN: This password reset link is not valid."
    }
  
    // Reject used/expired status OR past expiry (just-in-time check; the hourly cron is hygiene only).
    precondition ($reset_token.status == "pending" && $reset_token.expires_at > now) {
      error_type = "badrequest"
      error = "RESET_TOKEN_EXPIRED: This password reset link has expired or already been used. Please request a new one."
    }
  
    // Backend length-only guard (frontend enforces the character-class requirements).
    precondition (($input.new_password|strlen) >= 12) {
      error_type = "badrequest"
      error = "WEAK_PASSWORD: Password must be at least 12 characters."
    }
  
    db.get providers {
      field_name = "id"
      field_value = `$var.reset_token.provider_id`
    } as $provider
  
    precondition ($provider != null) {
      error_type = "notfound"
      error = "INVALID_RESET_TOKEN: This password reset link is not valid."
    }
  
    // Set the new password — password-type field auto-bcrypts the plaintext on write.
    db.edit providers {
      field_name = "id"
      field_value = `$var.provider.id`
      enforce_hidden_fields = false
      data = {password_hash: `$input.new_password`}
    } as $provider_updated
  
    // Consume the token (single-use).
    db.edit password_reset_tokens {
      field_name = "id"
      field_value = `$var.reset_token.id`
      enforce_hidden_fields = false
      data = {status: "used", used_at: `now`}
    } as $token_updated
  
    // Issue a fresh 1-day JWT for auto-login — same shape as /auth/login.
    security.create_auth_token {
      table = "providers"
      extras = {}
      expiration = 86400
      id = $provider.id
    } as $auth_token
  }

  response = {
    token   : `$var.auth_token`
    provider: `$var.provider|unset:"password_hash"`
  }
}