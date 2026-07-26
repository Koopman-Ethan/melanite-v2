query "admin/bookings" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition ($provider.is_admin || $provider.role == "medical_director") {
      error_type = "accessdenied"
      error = "ADMIN_ONLY: Admin or Medical Director access required."
    }
  
    db.query bookings {
      return = {type: "list"}
    } as $bookings
  
    var $result {
      value = `[]`
    }
  
    foreach ($bookings) {
      each as $bk {
        db.get providers {
          field_name = "id"
          field_value = `$bk.provider_id`
        } as $prov
      
        var $prov_name {
          value = `$var.prov.first_name|concat:" "|concat:$var.prov.last_name`
        }
      
        var $svc_name {
          value = `""`
        }
      
        var $svc_color {
          value = `""`
        }
      
        db.get provider_services {
          field_name = "id"
          field_value = `$bk.provider_service_id`
        } as $ps
      
        conditional {
          if ($ps.id != null) {
            db.get services {
              field_name = "id"
              field_value = `$var.ps.service_id`
            } as $svc
          
            conditional {
              if ($svc.id != null) {
                var.update $svc_name {
                  value = `$var.svc.name`
                }
              
                var.update $svc_color {
                  value = `$var.svc.color_hex`
                }
              }
            }
          }
        }
      
        var $row {
          value = `{}|set:"id":$bk.id|set:"start":$bk.start_time|set:"end":$bk.end_time|set:"provider_id":$bk.provider_id|set:"provider_name":$var.prov_name|set:"service_name":$var.svc_name|set:"service_color":$var.svc_color|set:"client_name":$bk.client_name|set:"treatment_area":$bk.treatment_area|set:"duration_mins":$bk.duration_mins|set:"price":$bk.price|set:"status":$bk.status`
        }
      
        var.update $result {
          value = `$var.result|push:$var.row`
        }
      }
    }
  }

  response = {
    bookings: `$var.result`
    total   : `$var.result|count`
    tz      : `"America/Denver"`
  }
}