// Magic-link landing validation. Returns invite email + expires_at or 404/410.
query "auth/onboard/{token}" verb=GET {
  api_group = "melanite_v1"

  input {
    text token filters=trim
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
  }

  response = {
    email     : `$var.existing_invite.email`
    expires_at: `$var.existing_invite.expires_at`
  }
}