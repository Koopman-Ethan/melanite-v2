// Standard provider login. Used for mid-onboarding resume and post-onboarding logins. Returns JWT + provider.
query "auth/login" verb=POST {
  api_group = "melanite_v1"

  input {
    email email filters=trim|lower
    text password filters=trim {
      sensitive = true
    }
  }

  stack {
    var $email_normalized {
      value = `$input.email|to_lower|trim`
    }
  
    db.get providers {
      field_name = "email"
      field_value = $email_normalized
      output = [
        "id"
        "joined_at"
        "email"
        "password_hash"
        "first_name"
        "last_name"
        "phone"
        "credentials"
        "license_number"
        "license_state"
        "license_expiry"
        "malpractice_insurance"
        "stripe_account_id"
        "stripe_onboarding_complete"
        "status"
        "onboarding_step"
        "last_login_at"
        "is_admin"
        "role"
      ]
    } as $provider
  
    precondition ($provider != null) {
      error_type = "unauthorized"
      error = "Invalid credentials."
    }
  
    precondition ($provider.status != "inactive") {
      error_type = "accessdenied"
      error = "Account deactivated."
    }
  
    security.check_password {
      text_password = $input.password
      hash_password = $provider.password_hash
    } as $password_valid
  
    precondition ($password_valid) {
      error_type = "unauthorized"
      error = "Invalid credentials."
    }
  
    db.edit providers {
      field_name = "id"
      field_value = $provider.id
      enforce_hidden_fields = false
      data = {last_login_at: now}
    } as $providers1
  
    security.create_auth_token {
      table = "providers"
      extras = {}
      expiration = 86400
      id = $provider.id
    } as $auth_token
  }

  response = {
    token   : $auth_token
    provider: `$var.provider|unset:"password_hash"`
  }
}