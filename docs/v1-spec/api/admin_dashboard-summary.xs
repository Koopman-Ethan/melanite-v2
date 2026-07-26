//  GET /admin/dashboard-summary — ADMIN. Spec 3.3.4.
//  Platform totals for the admin home: active providers, bookings this month (start_time
//  in current MT month, excluding cancelled), active med-director subscriptions, this-month
//  revenue (SUM melanite_cut), pending checkout links. No mocked widgets.
// 
//  2026-07-25 — FET-01 Phase 5. ADDITIVE ONLY. month_revenue stays BOOKING-ONLY (unchanged
//  value); package revenue arrives as package_month_revenue, and month_revenue_total is the
//  combined figure. bookings_this_month already counts $0 package redemptions and should —
//  it is an activity count, not a money count.
query "admin/dashboard-summary" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$var.provider.is_admin`) {
      error_type = "accessdenied"
      error = "ADMIN_ONLY: Admin access required."
    }
  
    var $cur_month {
      value = `now|format_timestamp:"Y-m":"America/Denver"`
    }
  
    db.query providers {
      where = $db.providers.status == "active" && $db.providers.role == "real_provider"
      return = {type: "list"}
    } as $active_providers
  
    db.query providers {
      where = $db.providers.medical_director_status == "active" && $db.providers.is_admin != true && $db.providers.role != "test_provider"
      return = {type: "list"}
    } as $active_md
  
    db.query checkout_links {
      where = $db.checkout_links.status == "pending"
      return = {type: "list"}
    } as $pending_links
  
    db.query bookings {
      return = {type: "list"}
    } as $all_bookings
  
    var $bookings_this_month {
      value = `0`
    }
  
    foreach ($all_bookings) {
      each as $bk {
        var $bk_month {
          value = `$bk.start_time|format_timestamp:"Y-m":"America/Denver"`
        }
      
        conditional {
          if ($bk_month == $cur_month && $bk.status != "cancelled") {
            var.update $bookings_this_month {
              value = `$var.bookings_this_month|add:1`
            }
          }
        }
      }
    }
  
    db.query transactions {
      return = {type: "list"}
    } as $txns
  
    var $month_revenue {
      value = `0`
    }
  
    foreach ($txns) {
      each as $txn {
        var $txn_month {
          value = `$txn.created_at|format_timestamp:"Y-m":"America/Denver"`
        }
      
        conditional {
          if ($txn_month == $cur_month) {
            var.update $month_revenue {
              value = `$var.month_revenue|add:$txn.melanite_cut`
            }
          }
        }
      }
    }
  
    // ---------- FET-01 Phase 5: package ledger rollup ----------
    function.run get_platform_package_summary as $pkgsum
  
    var $month_revenue_total {
      value = `$var.month_revenue|add:$var.pkgsum.month_revenue`
    }
  }

  response = {
    active_providers                 : $active_providers|count
    active_med_director_subscriptions: $active_md|count
    bookings_this_month              : `$var.bookings_this_month`
    month_revenue                    : `$var.month_revenue`
    pending_links_count              : $pending_links|count
    package_month_revenue            : `$var.pkgsum.month_revenue`
    month_revenue_total              : `$var.month_revenue_total`
  }
}