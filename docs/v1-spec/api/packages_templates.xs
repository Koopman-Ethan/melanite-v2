// POST /packages/templates — FET-01 Phase 1. Create a template + its line items in one
// call. ALL validation runs before ANY write (no transactions on Free — BUG-13 lesson):
//   (a) every service_id exists in provider_services for THIS provider (eligibility)
//   (b) no duplicate service_id lines (one line per service)
//   (c) sum(per_session_value × quantity) == total_price, compared in integer cents
// WIPE-BUG LESSON (2026-07-22): omitted int inputs arrive as 0, not null — so
// expires_after_days is resolved to null-or-positive BEFORE the db.add.
// Not gated on packages_enabled — dark by design (nothing links here; auth-only).
query "packages/templates" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text name filters=trim
    text? description? filters=trim
    decimal total_price filters=min:0
    int? expires_after_days? filters=min:0
    object[1:50] items {
      schema {
        uuid service_id
        int quantity filters=min:1
        decimal per_session_value filters=min:0
      }
    }
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (($input.name|strlen) > 0) {
      error_type = "badrequest"
      error = "NAME_REQUIRED: Give the package a name."
    }
  
    precondition ($input.total_price > 0) {
      error_type = "badrequest"
      error = "INVALID_TOTAL: total_price must be greater than 0."
    }
  
    var $item_count {
      value = `$input.items|count`
    }
  
    var $uniq_count {
      value = $input.items|map:$$.service_id|unique|count
    }
  
    precondition ($item_count == $uniq_count) {
      error_type = "badrequest"
      error = "DUPLICATE_SERVICE_LINE: Each service can appear on only one line item. Use quantity for multiples."
    }
  
    var $sum {
      value = `0`
    }
  
    foreach ($input.items) {
      each as $item {
        db.query provider_services {
          where = $db.provider_services.provider_id == `$var.provider.id` && $db.provider_services.service_id == `$item.service_id`
          return = {type: "count"}
        } as $svc_count
      
        precondition ($svc_count > 0) {
          error_type = "badrequest"
          error = "SERVICE_NOT_OFFERED: Every line item must be a service you currently offer."
        }
      
        var $line_total {
          value = `$item.per_session_value|multiply:$item.quantity`
        }
      
        var.update $sum {
          value = `$var.sum|add:$var.line_total`
        }
      }
    }
  
    var $sum_cents {
      value = `$var.sum|multiply:100|round:0|to_int`
    }
  
    var $total_cents {
      value = `$input.total_price|multiply:100|round:0|to_int`
    }
  
    precondition ($sum_cents == $total_cents) {
      error_type = "badrequest"
      error = "TOTAL_MISMATCH: Line items (per-session value × quantity) must sum exactly to the package total."
    }
  
    var $exp_value {
      value = null
    }
  
    conditional {
      if ($input.expires_after_days != null && $input.expires_after_days > 0) {
        var.update $exp_value {
          value = `$input.expires_after_days`
        }
      }
    }
  
    db.add package_templates {
      enforce_hidden_fields = false
      data = {
        provider_id       : `$var.provider.id`
        name              : `$input.name`
        description       : `$input.description`
        total_price       : `$input.total_price`
        expires_after_days: `$var.exp_value`
        active            : true
      }
    } as $tpl
  
    foreach ($input.items) {
      each as $item {
        db.add package_template_items {
          enforce_hidden_fields = false
          data = {
            package_template_id: `$var.tpl.id`
            service_id         : `$item.service_id`
            quantity           : `$item.quantity`
            per_session_value  : `$item.per_session_value`
          }
        } as $tpl_item
      }
    }
  
    db.get package_templates {
      field_name = "id"
      field_value = `$var.tpl.id`
    } as $tpl_fresh
  
    db.query package_template_items {
      where = $db.package_template_items.package_template_id == `$var.tpl.id`
      return = {type: "list"}
    } as $tpl_items
  }

  response = {template: `$var.tpl_fresh`, items: `$var.tpl_items`}
}