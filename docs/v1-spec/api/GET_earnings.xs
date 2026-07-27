//  GET /earnings — provider JWT. Spec 3.3.2.
//  Real summary from transactions: lifetime + this-month provider_payout (payout already
//  INCLUDES tips per the Step-2 split math), tips_total, pending_payout, revenue-by-service,
//  and a monthly time series. All aggregation is loop-based (tiny volume, no dynamic keys).
//  Months are Mountain Time (America/Denver), matching GET /appointments.
// 
//  2026-07-25 — FET-01 Phase 5 (Reporting). ADDITIVE ONLY: every pre-existing response key keeps
//  its exact prior meaning and value. Package money lives in package_transactions, a SEPARATE
//  ledger, and is rolled up by the get_provider_package_summary function — never folded into the
//  booking totals. WHY: the 50/50 split settles at PURCHASE, so package payout is money received
//  for sessions not yet delivered (unearned revenue), not earnings for work done; mixing them
//  would misstate both. Package rows are also kept OUT of pending_payout — a package purchase is
//  a destination charge that settles immediately, so "pending" would be false.
query earnings verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query transactions {
      where = $db.transactions.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $txns
  
    var $cur_month {
      value = `now|format_timestamp:"Y-m":"America/Denver"`
    }
  
    var $lifetime_payout {
      value = `0`
    }
  
    var $month_payout {
      value = `0`
    }
  
    var $tips_total {
      value = `0`
    }
  
    var $month_tips {
      value = `0`
    }
  
    var $pending_payout {
      value = `0`
    }
  
    var $annotated {
      value = `[]`
    }
  
    var $months {
      value = `[]`
    }
  
    foreach ($txns) {
      each as $txn {
        var $txn_month {
          value = `$txn.created_at|format_timestamp:"Y-m":"America/Denver"`
        }
      
        var.update $lifetime_payout {
          value = `$var.lifetime_payout|add:$txn.provider_payout`
        }
      
        var.update $tips_total {
          value = `$var.tips_total|add:$txn.tip_amount`
        }
      
        conditional {
          if ($txn_month == $cur_month) {
            var.update $month_payout {
              value = `$var.month_payout|add:$txn.provider_payout`
            }
          
            var.update $month_tips {
              value = `$var.month_tips|add:$txn.tip_amount`
            }
          }
        }
      
        conditional {
          if ($txn.payout_status == "pending") {
            var.update $pending_payout {
              value = `$var.pending_payout|add:$txn.provider_payout`
            }
          }
        }
      
        db.get bookings {
          field_name = "id"
          field_value = `$txn.booking_id`
        } as $bk
      
        var $ann {
          value = `{}|set:"month":$var.txn_month|set:"payout":$txn.provider_payout|set:"tip":$txn.tip_amount|set:"provider_service_id":$var.bk.provider_service_id`
        }
      
        var.update $annotated {
          value = `$var.annotated|push:$var.ann`
        }
      
        var $month_seen {
          value = `false`
        }
      
        foreach ($months) {
          each as $seen_m {
            conditional {
              if ($seen_m == $txn_month) {
                var.update $month_seen {
                  value = `true`
                }
              }
            }
          }
        }
      
        conditional {
          if ($month_seen == false) {
            var.update $months {
              value = `$var.months|push:$var.txn_month`
            }
          }
        }
      }
    }
  
    var $series {
      value = `[]`
    }
  
    foreach ($months) {
      each as $m {
        var $m_payout {
          value = `0`
        }
      
        var $m_tips {
          value = `0`
        }
      
        foreach ($annotated) {
          each as $a {
            conditional {
              if ($a.month == $m) {
                var.update $m_payout {
                  value = `$var.m_payout|add:$a.payout`
                }
              
                var.update $m_tips {
                  value = `$var.m_tips|add:$a.tip`
                }
              }
            }
          }
        }
      
        var $bucket {
          value = `{}|set:"month":$m|set:"payout":$var.m_payout|set:"tips":$var.m_tips`
        }
      
        var.update $series {
          value = `$var.series|push:$var.bucket`
        }
      }
    }
  
    // ---------- FET-01 Phase 5: package rollup (separate ledger, separate keys) ----------
    function.run get_provider_package_summary {
      input = {provider_id: $provider.id}
    } as $pkgsum
  
    var $pkg_svc_payout {
      value = `$var.pkgsum.svc_payout`
    }
  
    var $pkg_redemptions {
      value = `$var.pkgsum.redemptions`
    }
  
    db.query provider_services {
      where = $db.provider_services.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $my_services
  
    var $by_service {
      value = `[]`
    }
  
    foreach ($my_services) {
      each as $ps {
        db.get services {
          field_name = "id"
          field_value = `$ps.service_id`
        } as $svc
      
        var $s_payout {
          value = `0`
        }
      
        var $s_count {
          value = `0`
        }
      
        foreach ($annotated) {
          each as $a2 {
            conditional {
              if ($a2.provider_service_id == $ps.id) {
                var.update $s_payout {
                  value = `$var.s_payout|add:$a2.payout`
                }
              
                var.update $s_count {
                  value = `$var.s_count|add:1`
                }
              }
            }
          }
        }
      
        var $s_pkg_payout {
          value = `0`
        }
      
        var $s_pkg_sessions {
          value = `0`
        }
      
        var $s_pkg_value {
          value = `0`
        }
      
        // package CASH — matched on the master service_id (apportioned at purchase)
        foreach ($pkg_svc_payout) {
          each as $pv {
            conditional {
              if ($pv.service_id == $ps.service_id) {
                var.update $s_pkg_payout {
                  value = `$var.s_pkg_payout|add:$pv.payout`
                }
              }
            }
          }
        }
      
        // package VOLUME — matched on provider_service_id (the booking's own config row)
        foreach ($pkg_redemptions) {
          each as $ra {
            conditional {
              if ($ra.provider_service_id == $ps.id) {
                var.update $s_pkg_sessions {
                  value = `$var.s_pkg_sessions|add:1`
                }
              
                var.update $s_pkg_value {
                  value = `$var.s_pkg_value|add:$ra.value`
                }
              }
            }
          }
        }
      
        var $s_row {
          value = `null`
        }
      
        conditional {
          if ($s_count > 0 || $s_pkg_sessions > 0 || $s_pkg_payout > 0) {
            var.update $s_row {
              value = `{}|set:"provider_service_id":$ps.id|set:"service_name":$var.svc.name|set:"payout":$var.s_payout|set:"count":$var.s_count|set:"package_payout":$var.s_pkg_payout|set:"package_sessions":$var.s_pkg_sessions|set:"package_session_value":$var.s_pkg_value`
            }
          
            var.update $by_service {
              value = `$var.by_service|push:$var.s_row`
            }
          }
        }
      }
    }
  }

  response = {
    lifetime_payout           : `$var.lifetime_payout`
    month_payout              : `$var.month_payout`
    tips_total                : `$var.tips_total`
    month_tips                : `$var.month_tips`
    pending_payout            : `$var.pending_payout`
    by_service                : `$var.by_service`
    series                    : `$var.series`
    package_lifetime_payout   : `$var.pkgsum.lifetime_payout`
    package_month_payout      : `$var.pkgsum.month_payout`
    package_tips_total        : `$var.pkgsum.tips_total`
    package_month_tips        : `$var.pkgsum.month_tips`
    package_series            : `$var.pkgsum.series`
    sessions_redeemed_lifetime: `$var.pkgsum.sessions_redeemed_lifetime`
    sessions_redeemed_month   : `$var.pkgsum.sessions_redeemed_month`
    unearned_value            : `$var.pkgsum.unearned_value`
  }
}