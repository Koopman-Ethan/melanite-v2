query "providers/me/medical-director/subscribe" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text return_path?
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    var $ret {
      value = "/app/medical-director"
    }
  
    conditional {
      if ($input.return_path == "/app/onboard") {
        var.update $ret {
          value = "/app/onboard"
        }
      }
    }
  
    precondition ($provider.medical_director_status != "active" && $provider.medical_director_status != "past_due") {
      error_type = "badrequest"
      error = "ALREADY_SUBSCRIBED: You already have a medical director subscription."
    }
  
    db.edit providers {
      field_name = "id"
      field_value = `$var.provider.id`
      enforce_hidden_fields = false
      data = {medical_director_type: "melanite"}
    } as $prov_type_updated
  
    db.get platform_settings {
      field_name = "id"
      field_value = 1
    } as $settings
  
    precondition ($settings.medical_director_price_id != null) {
      error_type = "badrequest"
      error = "PRICE_NOT_CONFIGURED: The medical director plan is not configured."
    }
  
    var $billing_customer {
      value = `$var.provider.stripe_billing_customer_id`
    }
  
    conditional {
      if ($billing_customer == null) {
        api.request {
          url = "https://api.stripe.com/v1/customers"
          method = "POST"
          params = {}
            |set:"email":`$var.provider.email`
            |set:"name":`$var.provider.first_name|concat:" "|concat:$var.provider.last_name`
            |set:'["metadata[provider_id]"]':`$var.provider.id`
            |set:'["metadata[type]"]':"medical_director_billing"
          headers = []
            |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
            |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
            |push:"Content-Type: application/x-www-form-urlencoded"
        } as $cust_response
      
        var.update $billing_customer {
          value = `$var.cust_response.response.result.id`
        }
      
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          enforce_hidden_fields = false
          data = {stripe_billing_customer_id: `$var.billing_customer`}
        } as $prov_updated
      }
    }
  
    api.request {
      url = "https://api.stripe.com/v1/checkout/sessions"
      method = "POST"
      params = {}
        |set:"mode":"subscription"
        |set:"customer":`$var.billing_customer`
        |set:'["line_items[0][price]"]':`$var.settings.medical_director_price_id`
        |set:'["line_items[0][quantity]"]':"1"
        |set:"success_url":`$env.APP_BASE_URL|concat:$var.ret`
        |set:"cancel_url":`$env.APP_BASE_URL|concat:$var.ret`
        |set:'["metadata[provider_id]"]':`$var.provider.id`
        |set:'["subscription_data[metadata][provider_id]"]':`$var.provider.id`
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
        |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
        |push:"Content-Type: application/x-www-form-urlencoded"
    } as $session_response
  }

  response = {checkout_url: `$var.session_response.response.result.url`}
}