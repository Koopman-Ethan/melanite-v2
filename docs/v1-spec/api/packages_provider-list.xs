// GET /packages/provider-list — FET-01 Phase 4b. Provider-auth. The Packages
// index: EVERY client_packages owned by the caller (all statuses), newest first,
// each with client_name (nullable — UI falls back to client_email), template name,
// status, purchase/expiry, sessions_total/used/remaining. JIT expiry flip kept
// (FULL-ROW db.edit, wipe rule), mirroring client-balance. Ungated (D2).
query "packages/provider-list" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query client_packages {
      where = $db.client_packages.provider_id == `$var.provider.id`
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
      
        var $used_sum {
          value = `0`
        }
      
        var $total_sum {
          value = `0`
        }
      
        foreach ($items) {
          each as $item {
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
      
        var $pkg_entry {
          value = `{}|set:"client_package_id":$pkg.id|set:"client_name":$pkg.client_name|set:"client_email":$pkg.client_email|set:"template_name":$var.tpl.name|set:"status":$var.pkg_status|set:"purchased_at":$pkg.purchased_at|set:"expires_at":$pkg.expires_at|set:"sessions_total":$var.total_sum|set:"sessions_used":$var.used_sum|set:"sessions_remaining":$var.remaining_total`
        }
      
        var.update $out {
          value = `$var.out|push:$var.pkg_entry`
        }
      }
    }
  }

  response = {packages: `$var.out`}
}