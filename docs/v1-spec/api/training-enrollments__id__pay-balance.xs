// POST /training-enrollments/{id}/pay-balance — PUBLIC. Balance-collection page (spec §5).
// Creates or REUSES a PLATFORM PaymentIntent for the LIVE remaining balance_due (dollars).
// Guarded: 404 unknown id, 400 when nothing owed. Amount is 100% server-side.
// metadata type=training_balance + training_enrollment_id → webhook #3910318 handles success.
// Reuse rule: if stripe_balance_payment_intent_id exists and its status is still payable
// (not succeeded/canceled/processing), update its amount to the current balance and return
// its client_secret instead of minting a new PI on every page load.
query "training-enrollments/{id}/pay-balance" verb=POST {
  api_group = "melanite_v1"

  input {
    text id filters=trim
  }

  stack {
    db.get training_enrollments {
      field_name = "id"
      field_value = `$input.id`
    } as $enrollment
  
    precondition ($enrollment != null) {
      error_type = "notfound"
      error = "ENROLLMENT_NOT_FOUND: That enrollment does not exist."
    }
  
    precondition ($enrollment.balance_due > 0) {
      error_type = "badrequest"
      error = "BALANCE_ALREADY_PAID: Nothing is owed on this enrollment."
    }
  
    var $amount_cents {
      value = `$var.enrollment.balance_due|multiply:100|to_int`
    }
  
    var $client_secret {
      value = ""
    }
  
    var $pi_id {
      value = `$var.enrollment.stripe_balance_payment_intent_id`
    }
  
    var $reused {
      value = false
    }
  
    conditional {
      if ($pi_id != null && $pi_id != "") {
        api.request {
          url = `"https://api.stripe.com/v1/payment_intents/"|concat:$var.pi_id`
          method = "GET"
          headers = []
            |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
            |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
        } as $pi_get
      
        conditional {
          if ($pi_get.response.result.status != "succeeded" && $pi_get.response.result.status != "canceled" && $pi_get.response.result.status != "processing" && $pi_get.response.result.status != null) {
            api.request {
              url = `"https://api.stripe.com/v1/payment_intents/"|concat:$var.pi_id`
              method = "POST"
              params = {}|set:"amount":`$var.amount_cents`
              headers = []
                |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
                |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
                |push:"Content-Type: application/x-www-form-urlencoded"
            } as $pi_upd
          
            var.update $client_secret {
              value = `$var.pi_upd.response.result.client_secret`
            }
          
            var.update $reused {
              value = true
            }
          }
        }
      }
    }
  
    conditional {
      if ($reused == false) {
        api.request {
          url = "https://api.stripe.com/v1/payment_intents"
          method = "POST"
          params = {}
            |set:"amount":`$var.amount_cents`
            |set:"currency":"usd"
            |set:'["automatic_payment_methods[enabled]"]':"true"
            |set:'["metadata[training_enrollment_id]"]':`$var.enrollment.id`
            |set:'["metadata[type]"]':"training_balance"
          headers = []
            |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
            |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
            |push:"Content-Type: application/x-www-form-urlencoded"
        } as $pi_new
      
        db.edit training_enrollments {
          field_name = "id"
          field_value = `$var.enrollment.id`
          enforce_hidden_fields = false
          data = {
            stripe_balance_payment_intent_id: `$var.pi_new.response.result.id`
          }
        } as $enrollment_updated
      
        var.update $client_secret {
          value = `$var.pi_new.response.result.client_secret`
        }
      }
    }
  }

  response = {
    enrollment_id: `$var.enrollment.id`
    balance_due  : `$var.enrollment.balance_due`
    client_secret: `$var.client_secret`
  }
}