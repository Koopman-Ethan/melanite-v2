// GET /packages/detail — FET-01 Phase 4b. Provider-auth, ownership-scoped.
// Input client_package_id. One package + line items (service names,
// qty_total/used/remaining) + ordered redemption ledger (each package_redemptions
// row joined to its booking for start_time + status). JIT expiry flip (FULL-ROW,
// wipe rule). Ungated (D2).
// 2026-07-24 (Piece 3): each ledger entry now carries voided_at. Null = the
// redemption stands. Non-null = the booking was cancelled and the session was
// given back, so the UI must render that row WITHOUT a session index (its
// overall_index is legitimately reissued to a later redemption) and must not
// offer Cancel on it.
query "packages/detail" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text client_package_id filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (($input.client_package_id|strlen) > 0) {
      error_type = "badrequest"
      error = "CLIENT_PACKAGE_ID_REQUIRED: Provide the package id."
    }
  
    db.get client_packages {
      field_name = "id"
      field_value = `$input.client_package_id`
    } as $pkg
  
    precondition ($pkg != null) {
      error_type = "notfound"
      error = "PACKAGE_NOT_FOUND: No such package."
    }
  
    precondition ($pkg.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "PACKAGE_NOT_FOUND: No such package."
    }
  
    var $pkg_status {
      value = `$var.pkg.status`
    }
  
    conditional {
      if ($pkg.status == "active" && $pkg.expires_at != null && $pkg.expires_at < now) {
        db.edit client_packages {
          field_name = "id"
          field_value = `$var.pkg.id`
          enforce_hidden_fields = false
          data = {
            provider_id            : `$var.pkg.provider_id`
            client_email           : `$var.pkg.client_email`
            client_name            : `$var.pkg.client_name`
            package_template_id    : `$var.pkg.package_template_id`
            purchase_transaction_id: `$var.pkg.purchase_transaction_id`
            status                 : "expired"
            purchased_at           : `$var.pkg.purchased_at`
            expires_at             : `$var.pkg.expires_at`
          }
        } as $pkg_expired
      
        var.update $pkg_status {
          value = "expired"
        }
      }
    }
  
    db.get package_templates {
      field_name = "id"
      field_value = `$var.pkg.package_template_id`
    } as $tpl
  
    db.query client_package_items {
      where = $db.client_package_items.client_package_id == `$var.pkg.id`
      return = {type: "list"}
    } as $items
  
    var $items_out {
      value = `[]`
    }
  
    var $used_sum {
      value = `0`
    }
  
    var $total_sum {
      value = `0`
    }
  
    foreach ($items) {
      each as $item {
        db.get services {
          field_name = "id"
          field_value = `$item.service_id`
        } as $svc
      
        var $remaining {
          value = `$item.qty_total|subtract:$item.qty_used`
        }
      
        var $item_entry {
          value = `{}|set:"client_package_item_id":$item.id|set:"service_id":$item.service_id|set:"service_name":$var.svc.name|set:"per_session_value":$item.per_session_value|set:"qty_total":$item.qty_total|set:"qty_used":$item.qty_used|set:"remaining":$var.remaining`
        }
      
        var.update $items_out {
          value = `$var.items_out|push:$var.item_entry`
        }
      
        var.update $used_sum {
          value = `$var.used_sum|add:$item.qty_used`
        }
      
        var.update $total_sum {
          value = `$var.total_sum|add:$item.qty_total`
        }
      }
    }
  
    var $remaining_total {
      value = `$var.total_sum|subtract:$var.used_sum`
    }
  
    var $next_overall_index {
      value = `$var.used_sum|add:1`
    }
  
    db.query package_redemptions {
      where = $db.package_redemptions.client_package_id == `$var.pkg.id`
      sort = {overall_index: "asc"}
      return = {type: "list"}
    } as $redemptions
  
    var $ledger {
      value = `[]`
    }
  
    foreach ($redemptions) {
      each as $r {
        db.get bookings {
          field_name = "id"
          field_value = `$r.booking_id`
        } as $bk
      
        db.get client_package_items {
          field_name = "id"
          field_value = `$r.client_package_item_id`
        } as $r_item
      
        db.get services {
          field_name = "id"
          field_value = `$r_item.service_id`
        } as $r_svc
      
        var $led_entry {
          value = `{}|set:"redemption_id":$r.id|set:"overall_index":$r.overall_index|set:"service_index":$r.service_index|set:"service_name":$var.r_svc.name|set:"redeemed_at":$r.redeemed_at|set:"voided_at":$r.voided_at|set:"booking_id":$r.booking_id|set:"booking_start_time":$var.bk.start_time|set:"booking_status":$var.bk.status`
        }
      
        var.update $ledger {
          value = `$var.ledger|push:$var.led_entry`
        }
      }
    }
  
    var $pkg_out {
      value = `{}|set:"client_package_id":$var.pkg.id|set:"client_name":$var.pkg.client_name|set:"client_email":$var.pkg.client_email|set:"template_name":$var.tpl.name|set:"status":$var.pkg_status|set:"purchased_at":$var.pkg.purchased_at|set:"expires_at":$var.pkg.expires_at|set:"sessions_total":$var.total_sum|set:"sessions_used":$var.used_sum|set:"sessions_remaining":$var.remaining_total|set:"next_overall_index":$var.next_overall_index`
    }
  }

  response = {
    package    : `$var.pkg_out`
    items      : `$var.items_out`
    redemptions: `$var.ledger`
  }
}