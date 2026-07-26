// Create or refresh a Stripe Connect Express account for the authenticated provider and mint a one-time Account Link for hosted onboarding.
query "providers/me/stripe/onboarding-link" verb=POST {
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
  
    var $account_id {
      value = `$var.provider.stripe_account_id`
    }
  
    conditional {
      if (`$var.provider.stripe_account_id` == null) {
        api.request {
          url = "https://api.stripe.com/v1/accounts"
          method = "POST"
          params = {}
            |set:"type":"express"
            |set:"country":"US"
            |set:"email":`$var.provider.email`
            |set:'["capabilities[transfers][requested]"]':"true"
            |set:'["capabilities[tax_reporting_us_1099_k][requested]"]':"true"
            |set:"business_type":"individual"
            |set:'["metadata[provider_id]"]':`$var.provider.id`
          headers = []
            |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
            |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
            |push:"Content-Type: application/x-www-form-urlencoded"
        } as $stripe_account_response
      
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          enforce_hidden_fields = false
          data = {
            stripe_account_id         : `$var.stripe_account_response.response.result.id`
            stripe_onboarding_complete: false
          }
        } as $updated_provider
      
        var.update $account_id {
          value = `$var.stripe_account_response.response.result.id`
        }
      }
    }
  
    api.request {
      url = "https://api.stripe.com/v1/account_links"
      method = "POST"
      params = {}
        |set:"account":`$var.account_id`
        |set:"type":"account_onboarding"
        |set:"return_url":`$env.APP_BASE_URL|concat:"/app/stripe-return"`
        |set:"refresh_url":`$env.APP_BASE_URL|concat:"/app/stripe-refresh"`
        |set:"collection_options[fields]":"eventually_due"
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
        |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
        |push:"Content-Type: application/x-www-form-urlencoded"
    } as $account_link_response
  }

  response = {
    url              : `$var.account_link_response.response.result.url`
    expires_at       : `$var.account_link_response.response.result.expires_at`
    stripe_account_id: `$var.account_id`
  }
}