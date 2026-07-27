// PATCH /provider-services/{provider_service_id} — provider JWT. Spec 3.3.1.
// Edit price / duration_mins / is_active on the caller's own service row.
// Validation: ownership, price > 0, services.min_duration_mins <= duration <= max_duration_mins.
// Frontend sends ONLY changed fields (omit -> null). is_active uses an explicit null-check
// (first_notempty cannot set a boolean back to false).
query "provider-services/{provider_service_id}" verb=PATCH {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text provider_service_id filters=trim
    decimal price?
    int duration_mins?
    bool? is_active?
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    var $ps_id {
      value = `$input.provider_service_id`
    }
  
    db.get provider_services {
      field_name = "id"
      field_value = `$var.ps_id`
    } as $ps
  
    precondition ($ps != null) {
      error_type = "notfound"
      error = "SERVICE_NOT_FOUND: That service configuration does not exist."
    }
  
    precondition ($ps.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "NOT_YOURS: You can only edit your own services."
    }
  
    db.get services {
      field_name = "id"
      field_value = `$var.ps.service_id`
    } as $svc
  
    var $new_price {
      value = `$input.price|first_notempty:$var.ps.price`
    }
  
    precondition ($new_price > 0) {
      error_type = "badrequest"
      error = "INVALID_PRICE: Price must be greater than zero."
    }
  
    var $new_duration {
      value = `$input.duration_mins|first_notempty:$var.ps.duration_mins`
    }
  
    precondition ($new_duration >= $svc.min_duration_mins) {
      error_type = "badrequest"
      error = "DURATION_OUT_OF_RANGE: Duration is below the minimum for this service."
    }
  
    precondition ($new_duration <= $svc.max_duration_mins) {
      error_type = "badrequest"
      error = "DURATION_OUT_OF_RANGE: Duration is above the maximum for this service."
    }
  
    var $new_active {
      value = `$var.ps.is_active`
    }
  
    conditional {
      if ($input.is_active !== null) {
        var.update $new_active {
          value = `$input.is_active`
        }
      }
    }
  
    db.edit provider_services {
      field_name = "id"
      field_value = `$var.ps_id`
      enforce_hidden_fields = false
      data = {
        price        : `$var.new_price`
        duration_mins: `$var.new_duration`
        is_active    : `$var.new_active`
      }
    } as $updated
  
    var $item {
      value = `{}|set:"id":$var.updated.id|set:"service_id":$var.updated.service_id|set:"name":$var.svc.name|set:"price":$var.updated.price|set:"duration_mins":$var.updated.duration_mins|set:"is_active":$var.updated.is_active|set:"min_duration_mins":$var.svc.min_duration_mins|set:"max_duration_mins":$var.svc.max_duration_mins`
    }
  }

  response = {service: `$var.item`}
}