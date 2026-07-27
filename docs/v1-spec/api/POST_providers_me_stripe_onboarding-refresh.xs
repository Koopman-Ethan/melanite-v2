// Refresh URL handler for Stripe Connect hosted onboarding. Mints a fresh Account Link when the previous one expired. Assumes provider already has a stripe_account_id — returns 400 NO_STRIPE_ACCOUNT if not.
query "providers/me/stripe/onboarding-refresh" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text return_url filters=trim
    text refresh_url filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: `$auth.id`}
    } as $provider
  
    precondition (`$var.provider.stripe_account_id` != null) {
      error_type = "badrequest"
      error = '"Onboarding has not been started."'
    }
  
    api.request {
      url = "https://api.stripe.com/v1/account_links"
      method = "POST"
      params = {}
        |set:"account":`$var.provider.stripe_account_id`
        |set:"type":"account_onboarding"
        |set:"return_url":`$env.APP_BASE_URL|concat:"/app/stripe-return"`
        |set:"refresh_url":`$env.APP_BASE_URL|concat:"/app/stripe-refresh"`
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
        |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
        |push:"Content-Type: application/x-www-form-urlencoded"
    } as $account_link_response
  }

  response = {
    url              : `$var.account_link_response.response.result.url`
    expires_at       : `$var.account_link_response.response.result.expires_at`
    stripe_account_id: `$var.provider.stripe_account_id`
  }
}