// GET /pay/package/{token} — FET-01 Phase 2 (+4b Part D client_name).
query "pay/package/{token}" verb=GET {
  api_group = "melanite_v1"

  input {
    text token filters=trim
  }

  stack {
    var $tok {
      value = `$input.token`
    }
  
    db.get package_checkout_links {
      field_name = "token"
      field_value = `$var.tok`
    } as $link
  
    precondition ($link != null) {
      error_type = "notfound"
      error = "LINK_NOT_FOUND: That payment link does not exist."
    }
  
    precondition ($link.status != "cancelled") {
      error_type = "badrequest"
      error = "LINK_CANCELLED: This payment link was cancelled."
    }
  
    var $status {
      value = `$var.link.status`
    }
  
    conditional {
      if ($link.status == "pending" && $link.expires_at < now) {
        db.edit package_checkout_links {
          field_name = "id"
          field_value = `$var.link.id`
          enforce_hidden_fields = false
          data = {
            token                   : `$var.link.token`
            package_template_id     : `$var.link.package_template_id`
            provider_id             : `$var.link.provider_id`
            client_email            : `$var.link.client_email`
            client_name             : `$var.link.client_name`
            status                  : "expired"
            tip_amount              : `$var.link.tip_amount`
            stripe_customer_id      : `$var.link.stripe_customer_id`
            stripe_payment_intent_id: `$var.link.stripe_payment_intent_id`
            paid_at                 : `$var.link.paid_at`
            expires_at              : `$var.link.expires_at`
          }
        } as $expired_link
      
        var.update $status {
          value = "expired"
        }
      }
    }
  
    precondition ($status != "expired") {
      error_type = "badrequest"
      error = "LINK_EXPIRED: This payment link has expired."
    }
  
    db.get package_templates {
      field_name = "id"
      field_value = `$var.link.package_template_id`
    } as $tpl
  
    db.get providers {
      field_name = "id"
      field_value = `$var.link.provider_id`
    } as $prov
  
    db.query package_template_items {
      where = $db.package_template_items.package_template_id == `$var.tpl.id`
      return = {type: "list"}
    } as $tpl_items
  
    var $items_out {
      value = `[]`
    }
  
    foreach ($tpl_items) {
      each as $item {
        db.get services {
          field_name = "id"
          field_value = `$item.service_id`
        } as $svc
      
        var $item_entry {
          value = `{}|set:"service_id":$item.service_id|set:"service_name":$var.svc.name|set:"quantity":$item.quantity|set:"per_session_value":$item.per_session_value`
        }
      
        var.update $items_out {
          value = `$var.items_out|push:$var.item_entry`
        }
      }
    }
  
    var $resp_template {
      value = `{}|set:"name":$var.tpl.name|set:"description":$var.tpl.description|set:"total_price":$var.tpl.total_price|set:"expires_after_days":$var.tpl.expires_after_days|set:"active":$var.tpl.active`
    }
  
    var $resp_provider {
      value = `{}|set:"first_name":$var.prov.first_name|set:"last_name":$var.prov.last_name|set:"credentials":$var.prov.credentials`
    }
  }

  response = {
    status      : `$var.status`
    tip_amount  : `$var.link.tip_amount`
    client_email: `$var.link.client_email`
    client_name : `$var.link.client_name`
    paid_at     : `$var.link.paid_at`
    expires_at  : `$var.link.expires_at`
    template    : `$var.resp_template`
    items       : `$var.items_out`
    provider    : `$var.resp_provider`
  }
}