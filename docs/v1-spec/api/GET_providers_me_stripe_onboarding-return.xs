// Return URL handler for Stripe Connect hosted onboarding. Reads live account state from Stripe, updates providers.stripe_onboarding_complete, returns state to frontend. Complementary to the account.updated webhook — UX accelerant for not waiting on webhook latency.
query "providers/me/stripe/onboarding-return" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: `$auth.id`}
    } as $provider
  
    precondition (`$var.provider.stripe_account_id` != null) {
      error_type = "badrequest"
      error = "Start onboarding first."
    }
  
    api.request {
      url = `"https://api.stripe.com/v1/accounts/"|concat:$var.provider.stripe_account_id`
      method = "GET"
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
        |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
    } as $stripe_account
  
    var $onboarding_complete {
      value = false
    }
  
    conditional {
      if (`$var.stripe_account.response.result.charges_enabled` && `$var.stripe_account.response.result.payouts_enabled`) {
        var.update $onboarding_complete {
          value = true
        }
      }
    }
  
    db.edit providers {
      field_name = "id"
      field_value = `$var.provider.id`
      enforce_hidden_fields = false
      data = {stripe_onboarding_complete: `$var.onboarding_complete`}
    } as $updated_provider
  }

  response = {
    onboarding_complete        : `$var.onboarding_complete`
    charges_enabled            : `$var.stripe_account.response.result.charges_enabled`
    payouts_enabled            : `$var.stripe_account.response.result.payouts_enabled`
    requirements_currently_due : `$var.stripe_account.response.result.requirements.currently_due`
    requirements_eventually_due: `$var.stripe_account.response.result.requirements.eventually_due`
    requirements_past_due      : `$var.stripe_account.response.result.requirements.past_due`
  }
}