// GET /appointments — provider JWT. Spec 3.2.3. List the caller's bookings, newest first.
// Optional filters: status (upcoming|completed|cancelled|no_show), month (YYYY-MM, Mountain Time), provider_service_id.
// v1: no server-side pagination/search (single-laser volume is small; frontend filters client-side if needed).
query appointments verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text? status? filters=trim
    text? month? filters=trim
    text? provider_service_id? filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query bookings {
      where = $db.bookings.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $my_bookings
  
    var $f_status {
      value = `$input.status`
    }
  
    var $f_month {
      value = `$input.month`
    }
  
    var $f_ps {
      value = `$input.provider_service_id`
    }
  
    var $result {
      value = `[]`
    }
  
    foreach ($my_bookings) {
      each as $bk {
        var $keep {
          value = true
        }
      
        conditional {
          if ($f_status != null && $f_status != "" && $bk.status != $f_status) {
            var.update $keep {
              value = false
            }
          }
        }
      
        conditional {
          if ($f_ps != null && $f_ps != "" && $bk.provider_service_id != $f_ps) {
            var.update $keep {
              value = false
            }
          }
        }
      
        var $bk_month {
          value = `$bk.start_time|format_timestamp:"Y-m":"America/Denver"`
        }
      
        conditional {
          if ($f_month != null && $f_month != "" && $bk_month != $f_month) {
            var.update $keep {
              value = false
            }
          }
        }
      
        conditional {
          if ($keep) {
            var.update $result {
              value = `$var.result|push:$bk`
            }
          }
        }
      }
    }
  }

  response = {appointments: `$var.result`, total: ($var.result|count)}
}