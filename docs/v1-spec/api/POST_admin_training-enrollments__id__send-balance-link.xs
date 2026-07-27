// POST /admin/training-enrollments/{id}/send-balance-link — ADMIN. Spec §6 (2026-07-06 repurposed).
// Sends (or RE-sends) the branded balance email with the STABLE public page link
// APP_BASE_URL/training-balance?e={enrollment_id}. No PaymentIntent is created here —
// the /training-balance page mints/reuses the PI itself via POST /training-enrollments/{id}/pay-balance.
// Guarded: 404 unknown id, 400 when nothing owed. Returns the URL + email_sent flag.
query "admin/training-enrollments/{id}/send-balance-link" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text id filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$var.provider.is_admin`) {
      error_type = "accessdenied"
      error = "ADMIN_ONLY: Admin access required."
    }
  
    db.get training_enrollments {
      field_name = "id"
      field_value = `$input.id`
    } as $enrollment
  
    precondition (`$var.enrollment` != null) {
      error_type = "notfound"
      error = "ENROLLMENT_NOT_FOUND: That enrollment does not exist."
    }
  
    precondition (`$var.enrollment.balance_due` > 0) {
      error_type = "badrequest"
      error = "BALANCE_ALREADY_PAID: Nothing is owed on this enrollment."
    }
  
    db.get training_courses {
      field_name = "id"
      field_value = `$var.enrollment.training_course_id`
    } as $course
  
    var $pay_url {
      value = `$env.APP_BASE_URL|concat:"/training-balance?e="|concat:$var.enrollment.id`
    }
  
    var $email_sent {
      value = false
    }
  
    conditional {
      if ($env.RESEND_API_KEY != "") {
        var $bal_html {
          value = `"<div style='font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px'><div style='background:#0e0e0e;padding:18px;text-align:center'><span style='color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold'>MELANITE</span></div><div style='padding:26px;border:1px solid #e7e2d8'><h2 style='color:#1a1a1a;margin:0 0 12px'>Your training balance, "|concat:$var.enrollment.first_name|concat:"</h2><p>You have a remaining balance of $"|concat:$var.enrollment.balance_due|concat:" for your Laser Certification Training, due by "|concat:$var.enrollment.balance_due_date|concat:".</p><p style='color:#555'>Day 1: "|concat:$var.course.day1_date|concat:"<br>Day 2: "|concat:$var.course.day2_date|concat:"</p><div style='text-align:center;margin:20px 0'><a href='"|concat:$var.pay_url|concat:"' style='background:#B8965A;color:#ffffff;text-decoration:none;padding:12px 28px;display:inline-block;font-weight:bold'>Pay your remaining balance</a></div><p style='color:#555;font-size:13px'>Or paste this link into your browser: "|concat:$var.pay_url|concat:"</p><p>Questions? Contact melanitelasersuite@gmail.com.</p></div></div>"`
        }
      
        api.request {
          url = "https://api.resend.com/emails"
          method = "POST"
          params = {}
            |set:"from":`$env.RESEND_FROM`
            |set:"to":`$var.enrollment.email`
            |set:"subject":"Your Melanite training balance"
            |set:"html":`$var.bal_html`
          headers = []
            |push:`"Authorization: Bearer "|concat:$env.RESEND_API_KEY`
            |push:"Content-Type: application/json"
        } as $bal_email_response
      
        var.update $email_sent {
          value = true
        }
      }
    }
  }

  response = {
    enrollment_id: `$var.enrollment.id`
    balance_due  : `$var.enrollment.balance_due`
    url          : `$var.pay_url`
    email_sent   : `$var.email_sent`
  }
}