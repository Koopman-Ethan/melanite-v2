query "providers/me/medical-director" verb=GET {
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
  
    var $mcount {
      value = `$var.memberships|count`
    }
  
    var $renewal_date {
      value = `null`
    }
  
    var $cancel_at_period_end {
      value = `false`
    }
  
    conditional {
      if ($mcount > 0) {
        var.update $renewal_date {
          value = `$var.memberships|first|get:"renewal_date"`
        }
      
        var.update $cancel_at_period_end {
          value = `$var.memberships|first|get:"cancel_at_period_end"`
        }
      }
    }
  }

  response = {
    type                : `$var.provider.medical_director_type`
    status              : `$var.provider.medical_director_status`
    renewal_date        : `$var.renewal_date`
    cancel_at_period_end: `$var.cancel_at_period_end`
  }
}