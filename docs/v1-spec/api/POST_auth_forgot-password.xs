// POST /auth/forgot-password — PUBLIC. Spec §3.5.2.
// ALWAYS returns 200 { ok: true } — no email enumeration.
// If a provider matches AND status != "inactive" AND no pending token issued in the last 5 min:
//   issue a reset token (expires_at = now + 1h). Email the link when SendGrid is live; manual share until then.
// Token = two concatenated UUIDs (mirrors POST /bookings/create token gen).
// Constant response regardless of whether a token was issued (anti-enumeration).
query "auth/forgot-password" verb=POST {
  api_group = "melanite_v1"

  input {
    email email filters=trim|lower
  }

  stack {
    var $email {
      value = `$input.email`
    }
  
    db.get providers {
      field_name = "email"
      field_value = `$var.email`
    } as $provider
  
    // 5-minute throttle cutoff (epoch ms; add_secs_to_timestamp with negative seconds subtracts).
    var $cutoff {
      value = `now|add_secs_to_timestamp:-300`
    }
  
    conditional {
      if ($provider != null && $provider.status != "inactive") {
        db.query password_reset_tokens {
          where = $db.password_reset_tokens.provider_id == `$var.provider.id` && $db.password_reset_tokens.status == "pending" && $db.password_reset_tokens.sent_at > `$var.cutoff`
          return = {type: "list"}
        } as $recent_tokens
      
        conditional {
          if (($recent_tokens|count) == 0) {
            security.create_uuid as $t1
            security.create_uuid as $t2
            var $token {
              value = `$var.t1|concat:$var.t2:"-"`
            }
          
            var $expires_at {
              value = `now|add_secs_to_timestamp:3600`
            }
          
            db.add password_reset_tokens {
              enforce_hidden_fields = false
              data = {
                provider_id: `$var.provider.id`
                token      : `$var.token`
                status     : "pending"
                sent_at    : `now`
                expires_at : `$var.expires_at`
              }
            } as $reset_token
          
            var $reset_url {
              value = `$env.APP_BASE_URL|concat:'/auth/reset?token='|concat:$var.token`
            }
          
            conditional {
              if ($env.RESEND_API_KEY != "") {
                var $html {
                  value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>Reset your password</h2><p>Click the button below to choose a new password for your Melanite provider account.</p><p style='text-align:center;margin:24px 0'><a href='"|concat:$var.reset_url|concat:"' style='display:inline-block;background:#B8965A;color:#1a1a1a;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:bold'>Reset Password</a></p><p style='font-size:12px;color:#777'>If the button does not work, paste this link:<br>"|concat:$var.reset_url|concat:"</p><p style='font-size:12px;color:#999'>This link expires in 1 hour. If you did not request this, you can ignore this email.</p></div></div>"`
                }
              
                api.request {
                  url = "https://api.resend.com/emails"
                  method = "POST"
                  params = {}
                    |set:"from":`$env.RESEND_FROM`
                    |set:"to":`$var.email`
                    |set:"subject":"Reset your Melanite password"
                    |set:"html":`$var.html`
                  headers = []
                    |push:`'Authorization: Bearer '|concat:$env.RESEND_API_KEY`
                    |push:"Content-Type: application/json"
                } as $resend_response
              }
            }
          
            // TODO (SendGrid): send the email with link
            //   $env.APP_BASE_URL|concat:"/auth/reset?token="|concat:$var.token
            // Until SendGrid is live the link is shared manually (pulled from this table).
          }
        }
      }
    }
  }

  response = {ok: true}
}