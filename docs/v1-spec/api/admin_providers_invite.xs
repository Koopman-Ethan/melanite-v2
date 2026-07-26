// Admin issues a new provider invite. Generates magic-link token, persists invite_links row, returns the magic link (email dispatch added separately).
query "admin/providers/invite" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    email email filters=trim|lower
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$var.provider.is_admin`) {
      error_type = "accessdenied"
      error = "Only admins can issue invites."
    }
  
    db.get providers {
      field_name = "email"
      field_value = `$input.email`
    } as $existing_provider
  
    precondition (`$var.existing_provider` == null || `$var.existing_provider.status` == "inactive") {
      error_type = "badrequest"
      error = "An active account already exists for this email."
    }
  
    db.query invite_links {
      where = $db.invite_links.email == `$inputs.email` && $db.invite_links.status == "pending"
      sort = {invite_links.expires_at: "desc"}
      return = {type: "list"}
    } as $existing_invites
  
    conditional {
      if ($existing_invites[0] != 0) {
        db.edit invite_links {
          field_name = "id"
          field_value = $existing_invites[0].id
          enforce_hidden_fields = false
          data = {status: "expired"}
        } as $invite_links2
      }
    }
  
    security.create_uuid as $new_token
    db.add invite_links {
      enforce_hidden_fields = false
      data = {
        email              : `$input.email`
        invited_by_admin_id: `$var.provider.id`
        token              : `$var.new_token`
        status             : "pending"
        sent_at            : now
        expires_at         : `now|add_secs_to_timestamp:604800`
      }
    } as $new_invite
  
    var $magic_link {
      value = `$env.APP_BASE_URL|concat:"/onboard?token="|concat:$var.new_invite.token`
    }
  
    conditional {
      if ($env.RESEND_API_KEY != "") {
        var $invite_html {
          value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>You are invited to join Melanite</h2><p>You have been invited to become a provider at Melanite Laser Suite. Click below to set up your account and complete onboarding.</p><p style='text-align:center;margin:24px 0'><a href='"|concat:$var.magic_link|concat:"' style='display:inline-block;background:#B8965A;color:#1a1a1a;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:bold'>Accept Invitation</a></p><p style='font-size:12px;color:#777'>If the button does not work, paste this link:<br>"|concat:$var.magic_link|concat:"</p><p style='font-size:12px;color:#999'>This invitation link is unique to you. If you were not expecting this, you can ignore this email.</p></div></div>"`
        }
      
        api.request {
          url = "https://api.resend.com/emails"
          method = "POST"
          params = {}
            |set:"from":`$env.RESEND_FROM`
            |set:"to":`$input.email`
            |set:"subject":"You are invited to join Melanite Laser Suite"
            |set:"html":`$var.invite_html`
          headers = []
            |push:`'Authorization: Bearer '|concat:$env.RESEND_API_KEY`
            |push:"Content-Type: application/json"
        } as $resend_invite_response
      }
    }
  }

  response = {
    invite_id : `$var.new_invite.id`
    magic_link: `$var.magic_link`
    expires_at: `$var.new_invite.expires_at`
  }
}