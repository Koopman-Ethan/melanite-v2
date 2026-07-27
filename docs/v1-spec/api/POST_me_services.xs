// Step 5 batch insert: provider's chosen services with per-row price/duration/active. Flips provider from pending to active.
query "me/services" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    object[] services {
      schema {
        uuid service_id
        decimal price
        int duration_mins
        bool is_active
      }
    }
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$var.provider.onboarding_step` == 4 && `$var.provider.stripe_onboarding_complete`) {
      error_type = "badrequest"
      error = "Cannot configure services until Stripe Connect onboarding is complete."
    }
  
    precondition (`$input.services|count` > 0) {
      error_type = "badrequest"
      error = "At least one service must be selected."
    }
  
    foreach ($input.services) {
      each as $item {
        db.get services {
          field_name = "id"
          field_value = `$var.item.service_id`
        } as $service_def
      
        precondition (`$var.service_def` != null && `$var.service_def.active`) {
          error_type = "badrequest"
          error = "Invalid or inactive service."
        }
      
        precondition (`$var.item.duration_mins` >= `$var.service_def.min_duration_mins` && `$var.item.duration_mins` <= `$var.service_def.max_duration_mins`) {
          error_type = "badrequest"
          error = "Duration out of allowed range for this service."
        }
      
        precondition (`$var.item.price` > 0) {
          error_type = "badrequest"
          error = "Price must be greater than zero."
        }
      
        db.add provider_services {
          enforce_hidden_fields = false
          data = {
            provider_id  : `$var.provider.id`
            service_id   : `$var.item.service_id`
            price        : `$var.item.price`
            duration_mins: `$var.item.duration_mins`
            is_active    : `$var.item.is_active`
          }
        } as $provider_services1
      }
    }
  
    db.edit providers {
      field_name = "id"
      field_value = `$var.provider.id`
      enforce_hidden_fields = false
      data = {status: "active", onboarding_step: 5}
    } as $updated_provider
  
    db.query provider_services {
      where = `$var.provider.id` == $db.provider_services.provider_id
      return = {type: "list"}
    } as $all_services
  }

  response = {
    provider: `$var.updated_provider|unset:"password_hash"`
    services: `$var.all_services`
  }
}