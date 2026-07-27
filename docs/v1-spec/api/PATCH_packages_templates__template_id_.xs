// PATCH /packages/templates/{template_id} — FET-01 Phase 1. Partial update.
// WIPE-BUG LESSON (2026-07-22, verified live on THIS table): db.edit on
// package_templates NULLS any nullable column omitted from data. So this
// endpoint resolves EVERY template field first (input if provided+valid,
// else the current row value) and writes them ALL in ONE db.edit.
// items (when provided) = FULL REPLACE of the line-item set.
// Validation (all BEFORE any write): eligibility + duplicate check on the
// new set; sum-to-total (cents) on (new items ?? existing items) vs
// (new total_price ?? existing total_price).
// expires_after_days: omitted = unchanged; >0 = set; clear via clear_expiration=true.
// active: true here re-activates a soft-deleted template.
query "packages/templates/{template_id}" verb=PATCH {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text template_id filters=trim
    text? name? filters=trim
    text? description? filters=trim
    decimal? total_price? filters=min:0
    int? expires_after_days? filters=min:0
    bool? active?
    bool? clear_expiration?
    object[]? items? {
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
  
    db.get package_templates {
      field_name = "id"
      field_value = `$input.template_id`
    } as $tpl
  
    precondition ($tpl != null) {
      error_type = "notfound"
      error = "TEMPLATE_NOT_FOUND: That package template does not exist."
    }
  
    precondition ($tpl.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "TEMPLATE_NOT_FOUND: That package template does not belong to you."
    }
  
    var $effective_total {
      value = `$var.tpl.total_price`
    }
  
    conditional {
      if ($input.total_price != null) {
        precondition ($input.total_price > 0) {
          error_type = "badrequest"
          error = "INVALID_TOTAL: total_price must be greater than 0."
        }
      
        var.update $effective_total {
          value = `$input.total_price`
        }
      }
    }
  
    var $final_name {
      value = `$var.tpl.name`
    }
  
    conditional {
      if ($input.name != null && ($input.name|strlen) > 0) {
        var.update $final_name {
          value = `$input.name`
        }
      }
    }
  
    var $final_description {
      value = `$var.tpl.description`
    }
  
    conditional {
      if ($input.description != null && ($input.description|strlen) > 0) {
        var.update $final_description {
          value = `$input.description`
        }
      }
    }
  
    var $final_expires {
      value = `$var.tpl.expires_after_days`
    }
  
    conditional {
      if ($input.expires_after_days != null && $input.expires_after_days > 0) {
        var.update $final_expires {
          value = `$input.expires_after_days`
        }
      }
    }
  
    conditional {
      if ($input.clear_expiration) {
        var.update $final_expires {
          value = null
        }
      }
    }
  
    var $final_active {
      value = `$var.tpl.active`
    }
  
    conditional {
      if ($input.active != null) {
        var.update $final_active {
          value = `$input.active`
        }
      }
    }
  
    var $items_provided {
      value = `false`
    }
  
    conditional {
      if ($input.items != null) {
        var.update $items_provided {
          value = `true`
        }
      }
    }
  
    var $check_items {
      value = `[]`
    }
  
    conditional {
      if ($items_provided) {
        precondition (($input.items|count) > 0) {
          error_type = "badrequest"
          error = "NO_ITEMS: A package needs at least one line item."
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
      
        foreach ($input.items) {
          each as $item {
            db.query provider_services {
              where = $db.provider_services.provider_id == `$var.tpl.provider_id` && $db.provider_services.service_id == `$item.service_id`
              return = {type: "count"}
            } as $svc_count
          
            precondition ($svc_count > 0) {
              error_type = "badrequest"
              error = "SERVICE_NOT_OFFERED: Every line item must be a service you currently offer."
            }
          }
        }
      
        var.update $check_items {
          value = `$input.items`
        }
      }
    }
  
    conditional {
      if ($items_provided == false) {
        db.query package_template_items {
          where = $db.package_template_items.package_template_id == `$var.tpl.id`
          return = {type: "list"}
        } as $existing_items
      
        var.update $check_items {
          value = `$var.existing_items`
        }
      }
    }
  
    var $sum {
      value = `0`
    }
  
    foreach ($check_items) {
      each as $ci {
        var $line_total {
          value = `$ci.per_session_value|multiply:$ci.quantity`
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
      value = `$var.effective_total|multiply:100|round:0|to_int`
    }
  
    precondition ($sum_cents == $total_cents) {
      error_type = "badrequest"
      error = "TOTAL_MISMATCH: Line items (per-session value × quantity) must sum exactly to the package total."
    }
  
    db.edit package_templates {
      field_name = "id"
      field_value = `$var.tpl.id`
      enforce_hidden_fields = false
      data = {
        name              : `$var.final_name`
        description       : `$var.final_description`
        total_price       : `$var.effective_total`
        expires_after_days: `$var.final_expires`
        active            : `$var.final_active`
      }
    } as $tpl_updated
  
    conditional {
      if ($items_provided) {
        db.query package_template_items {
          where = $db.package_template_items.package_template_id == `$var.tpl.id`
          return = {type: "list"}
        } as $old_items
      
        foreach ($old_items) {
          each as $old {
            db.del package_template_items {
              field_name = "id"
              field_value = `$old.id`
            }
          }
        }
      
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
            } as $new_item
          }
        }
      }
    }
  
    db.get package_templates {
      field_name = "id"
      field_value = `$var.tpl.id`
    } as $tpl_fresh
  
    db.query package_template_items {
      where = $db.package_template_items.package_template_id == `$var.tpl.id`
      return = {type: "list"}
    } as $items_fresh
  }

  response = {template: `$var.tpl_fresh`, items: `$var.items_fresh`}
}