query "providers/me/billing-portal" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query memberships {
      where = $db.memberships.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $memberships
  
    precondition (`$var.memberships|count` > `0`) {
      error_type = "notfound"
      error = "No active membership found for this provider."
    }
  
    var $cust {
      value = `$var.memberships|first|get:"stripe_customer_id"`
    }
  
    api.request {
      url = "https://api.stripe.com/v1/billing_portal/sessions"
      method = "POST"
      params = {}
        |set:"customer":`$var.cust`
        |set:"return_url":`$env.APP_BASE_URL|concat:"/app/membership"`
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
        |push:"Content-Type: application/x-www-form-urlencoded"
    } as $portal
  
    var $url {
      value = `$var.portal.response.result.url`
    }
  }

  response = {url: `$var.url`}
}