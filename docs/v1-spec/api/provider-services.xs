// GET /provider-services — provider JWT. Spec 3.3.1.
// List the caller's services joined to master service definitions (name, description,
// min/max duration bounds for the edit UI, platform-wide active flag, color).
query "provider-services" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query provider_services {
      where = $db.provider_services.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $my_services
  
    var $result {
      value = `[]`
    }
  
    foreach ($my_services) {
      each as $ps {
        db.get services {
          field_name = "id"
          field_value = `$ps.service_id`
        } as $svc
      
        var $item {
          value = `{}|set:"id":$ps.id|set:"service_id":$ps.service_id|set:"name":$var.svc.name|set:"description":$var.svc.description|set:"price":$ps.price|set:"duration_mins":$ps.duration_mins|set:"is_active":$ps.is_active|set:"min_duration_mins":$var.svc.min_duration_mins|set:"max_duration_mins":$var.svc.max_duration_mins|set:"suggested_duration_mins":$var.svc.suggested_duration_mins|set:"service_active":$var.svc.active|set:"color_hex":$var.svc.color_hex`
        }
      
        var.update $result {
          value = `$var.result|push:$var.item`
        }
      }
    }
  }

  response = {services: `$var.result`, total: ($var.result|count)}
}