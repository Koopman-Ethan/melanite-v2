// GET /packages/client-balance — FET-01 Phase 3. Provider-auth. The provider's
// "does this client have sessions left?" read, and the endpoint the future
// /app/book redemption UI consumes. Input: client_email. Returns ALL of the
// caller's packages for that client (every status, newest first) — the UI needs
// to say "expired"/"exhausted" truthfully. Per package: template name, status,
// expires_at, totals + next overall_index; per line item: service id/name,
// qty_total, qty_used, remaining, next service_index.
// JIT expiry: an active package past its expires_at is flipped to "expired"
// during the read — FULL-ROW db.edit (the wipe rule), mirroring Phase 2's
// GET /pay/package/{token} pattern.
// Deliberately NOT gated on packages_enabled (D2): a paid package must always
// be readable/redeemable; rollback never strands paid value.
// ZERO Stripe calls. Zero writes except the JIT flip.
// 2026-07-24 HOTFIX: the JIT flip now carries client_name. Part D added that
// nullable column AFTER this endpoint was authored, so omitting it from the
// full-row edit was wiping the client's name on expiry (the wipe rule).
query "packages/client-balance" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text client_email filters=trim|lower
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (($input.client_email|strlen) > 0) {
      error_type = "badrequest"
      error = "CLIENT_EMAIL_REQUIRED: Provide the client's email to look up their packages."
    }
  
    var $cemail {
      value = `$input.client_email|trim|to_lower`
    }
  
    db.query client_packages {
      where = $db.client_packages.provider_id == `$var.provider.id` && $db.client_packages.client_email == `$var.cemail`
      sort = {purchased_at: "desc"}
      return = {type: "list"}
    } as $pkgs
  
    var $out {
      value = `[]`
    }
  
    foreach ($pkgs) {
      each as $pkg {
        var $pkg_status {
          value = `$pkg.status`
        }
      
        conditional {
          if ($pkg.status == "active" && $pkg.expires_at != null && $pkg.expires_at < now) {
            db.edit client_packages {
              field_name = "id"
              field_value = `$pkg.id`
              enforce_hidden_fields = false
              data = {
                provider_id            : `$pkg.provider_id`
                client_email           : `$pkg.client_email`
                client_name            : `$pkg.client_name`
                package_template_id    : `$pkg.package_template_id`
                purchase_transaction_id: `$pkg.purchase_transaction_id`
                status                 : "expired"
                purchased_at           : `$pkg.purchased_at`
                expires_at             : `$pkg.expires_at`
              }
            } as $pkg_expired
          
            var.update $pkg_status {
              value = "expired"
            }
          }
        }
      
        db.get package_templates {
          field_name = "id"
          field_value = `$pkg.package_template_id`
        } as $tpl
      
        db.query client_package_items {
          where = $db.client_package_items.client_package_id == `$pkg.id`
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
          
            var $next_service_index {
              value = `$item.qty_used|add:1`
            }
          
            var $item_entry {
              value = `{}|set:"client_package_item_id":$item.id|set:"service_id":$item.service_id|set:"service_name":$var.svc.name|set:"per_session_value":$item.per_session_value|set:"qty_total":$item.qty_total|set:"qty_used":$item.qty_used|set:"remaining":$var.remaining|set:"next_service_index":$var.next_service_index`
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
      
        var $pkg_entry {
          value = `{}|set:"client_package_id":$pkg.id|set:"client_name":$pkg.client_name|set:"template_name":$var.tpl.name|set:"status":$var.pkg_status|set:"purchased_at":$pkg.purchased_at|set:"expires_at":$pkg.expires_at|set:"sessions_total":$var.total_sum|set:"sessions_used":$var.used_sum|set:"sessions_remaining":$var.remaining_total|set:"next_overall_index":$var.next_overall_index|set:"items":$var.items_out`
        }
      
        var.update $out {
          value = `$var.out|push:$var.pkg_entry`
        }
      }
    }
  }

  response = {packages: `$var.out`}
}