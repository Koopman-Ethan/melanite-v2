// Accept invite, create provider account, issue JWT. Once successful, provider authenticates via /auth/login for the rest of onboarding.
query "auth/onboard/{token}/complete-step1" verb=POST {
  api_group = "melanite_v1"

  input {
    text token filters=trim
    text password filters=trim {
      sensitive = true
    }
  
    text first_name? filters=trim
    text last_name? filters=trim
    text? phone? filters=trim
  }

  stack {
    db.get invite_links {
      field_name = "token"
      field_value = `$input.token`
    } as $existing_invite
  
    precondition (`$var.existing_invite` != null) {
      error_type = "notfound"
      error = "Invalid invite link."
    }
  
    precondition (`$var.existing_invite.status` != "accepted") {
      error_type = "badrequest"
      error = "This invite has already been used. Please log in instead."
    }
  
    precondition (`$var.existing_invite.expires_at` > now && `$var.existing_invite.status` != "expired") {
      error_type = "badrequest"
      error = "This invite has expired. Please request a new one."
    }
  
    precondition (`"/^(?=.*[a-z])(?=.*[A-Z])(?=.*\\\\d)(?=.*[!@#$%^&*()_+\\\\-=\\\\[\\\\]{};':\"\\\\\\\\|,.<>\\\\/?]).{12,}$/"|regex_test:$input.password`) {
      error_type = "badrequest"
      error = "Password must be at least 12 characters with uppercase, lowercase, number, and symbol."
    }
  
    db.add providers {
      enforce_hidden_fields = false
      data = {
        joined_at      : "now"
        email          : `$var.existing_invite.email`
        password_hash  : `$input.password`
        first_name     : `$input.first_name`
        last_name      : `$input.last_name`
        phone          : `$input.phone`
        status         : "pending"
        onboarding_step: 1
        is_admin       : false
      }
    } as $new_provider
  
    db.edit invite_links {
      field_name = "id"
      field_value = `$var.existing_invite.id`
      enforce_hidden_fields = false
      data = {status: "accepted", accepted_at: now}
    } as $invite_links1
  
    security.create_auth_token {
      table = "providers"
      extras = {}
      expiration = 86400
      id = `$var.new_provider.id`
    } as $auth_token
  }

  response = {
    token   : `$var.auth_token`
    provider: `$var.new_provider|unset:"password_hash"`
  }
}