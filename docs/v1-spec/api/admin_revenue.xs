//  GET /admin/revenue — ADMIN. Spec 3.3.4.
//  Real platform revenue (SUM melanite_cut) lifetime + this month (MT), with per-provider
//  and per-service breakdowns and a monthly series. Loop-based aggregation (tiny volume).
//  During annotation each txn is resolved booking -> provider_service -> service_id so the
//  per-service pass needs no further joins.
// 
//  2026-07-25 — FET-01 Phase 5 (Reporting). ADDITIVE ONLY. Every pre-existing key stays
//  BOOKING-ONLY and keeps its exact prior value — that is what the /app/admin tiles mean today.
//  Package money (package_transactions, a separate ledger) arrives via the
//  get_platform_package_summary function in its own package_* keys, plus combined_* keys that
//  give Keoni the true platform total without redefining the existing ones.
//  NOTE: the `booking_id != null` clause below is a NO-OP (booking_id is non-nullable and
//  source is a single-value enum). Left in place deliberately — it costs nothing and editing a
//  live endpoint for a behaviour-neutral tidy-up is not worth the typo risk.
query "admin/revenue" verb=GET {
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
  
    db.query transactions {
      where = $db.transactions.booking_id != null
      return = {type: "list"}
    } as $txns
  
    var $cur_month {
      value = `now|format_timestamp:"Y-m":"America/Denver"`
    }
  
    var $lifetime_revenue {
      value = `0`
    }
  
    var $month_revenue {
      value = `0`
    }
  
    var $lifetime_gross {
      value = `0`
    }
  
    var $lifetime_payouts {
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
        // gross folded to include tips so Cut + Payout == Total everywhere
        // (provider_payout already includes the tip; melanite_cut does not).
        var $gross_w_tip {
          value = `$txn.gross_amount|add:$txn.tip_amount`
        }
      
        var $txn_month {
          value = `$txn.created_at|format_timestamp:"Y-m":"America/Denver"`
        }
      
        var.update $lifetime_revenue {
          value = `$var.lifetime_revenue|add:$txn.melanite_cut`
        }
      
        var.update $lifetime_gross {
          value = `$var.lifetime_gross|add:$var.gross_w_tip`
        }
      
        var.update $lifetime_payouts {
          value = `$var.lifetime_payouts|add:$txn.provider_payout`
        }
      
        conditional {
          if ($txn_month == $cur_month) {
            var.update $month_revenue {
              value = `$var.month_revenue|add:$txn.melanite_cut`
            }
          }
        }
      
        db.get bookings {
          field_name = "id"
          field_value = `$txn.booking_id`
        } as $bk
      
        var $svc_id {
          value = `null`
        }
      
        conditional {
          if ($bk.id != null) {
            db.get provider_services {
              field_name = "id"
              field_value = `$var.bk.provider_service_id`
            } as $ps
          
            var.update $svc_id {
              value = `$var.ps.service_id`
            }
          }
        }
      
        var $ann {
          value = `{}|set:"month":$var.txn_month|set:"cut":$txn.melanite_cut|set:"gross":$var.gross_w_tip|set:"payout":$txn.provider_payout|set:"provider_id":$txn.provider_id|set:"service_id":$var.svc_id`
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
        var $m_revenue {
          value = `0`
        }
      
        var $m_gross {
          value = `0`
        }
      
        foreach ($annotated) {
          each as $a {
            conditional {
              if ($a.month == $m) {
                var.update $m_revenue {
                  value = `$var.m_revenue|add:$a.cut`
                }
              
                var.update $m_gross {
                  value = `$var.m_gross|add:$a.gross`
                }
              }
            }
          }
        }
      
        var $bucket {
          value = `{}|set:"month":$m|set:"revenue":$var.m_revenue|set:"gross":$var.m_gross`
        }
      
        var.update $series {
          value = `$var.series|push:$var.bucket`
        }
      }
    }
  
    // ---------- FET-01 Phase 5: package ledger rollup ----------
    function.run get_platform_package_summary as $pkgsum
  
    var $pkg_annotated {
      value = `$var.pkgsum.annotated`
    }
  
    var $pkg_svc_ann {
      value = `$var.pkgsum.svc_ann`
    }
  
    var $combined_lifetime_revenue {
      value = `$var.lifetime_revenue|add:$var.pkgsum.lifetime_revenue`
    }
  
    var $combined_month_revenue {
      value = `$var.month_revenue|add:$var.pkgsum.month_revenue`
    }
  
    db.query providers {
      return = {type: "list"}
    } as $all_providers
  
    var $per_provider {
      value = `[]`
    }
  
    foreach ($all_providers) {
      each as $p {
        var $p_revenue {
          value = `0`
        }
      
        var $p_payout {
          value = `0`
        }
      
        var $p_gross {
          value = `0`
        }
      
        var $p_count {
          value = `0`
        }
      
        foreach ($annotated) {
          each as $a2 {
            conditional {
              if ($a2.provider_id == $p.id) {
                var.update $p_revenue {
                  value = `$var.p_revenue|add:$a2.cut`
                }
              
                var.update $p_payout {
                  value = `$var.p_payout|add:$a2.payout`
                }
              
                var.update $p_gross {
                  value = `$var.p_gross|add:$a2.gross`
                }
              
                var.update $p_count {
                  value = `$var.p_count|add:1`
                }
              }
            }
          }
        }
      
        var $p_pkg_revenue {
          value = `0`
        }
      
        var $p_pkg_payout {
          value = `0`
        }
      
        var $p_pkg_gross {
          value = `0`
        }
      
        var $p_pkg_count {
          value = `0`
        }
      
        foreach ($pkg_annotated) {
          each as $pa {
            conditional {
              if ($pa.provider_id == $p.id) {
                var.update $p_pkg_revenue {
                  value = `$var.p_pkg_revenue|add:$pa.cut`
                }
              
                var.update $p_pkg_payout {
                  value = `$var.p_pkg_payout|add:$pa.payout`
                }
              
                var.update $p_pkg_gross {
                  value = `$var.p_pkg_gross|add:$pa.gross`
                }
              
                var.update $p_pkg_count {
                  value = `$var.p_pkg_count|add:$pa.count`
                }
              }
            }
          }
        }
      
        var $p_row {
          value = `null`
        }
      
        conditional {
          if ($p_count > 0 || $p_pkg_count > 0) {
            var.update $p_row {
              value = `{}|set:"provider_id":$p.id|set:"provider_name":($p.first_name|concat:$p.last_name:" ")|set:"revenue":$var.p_revenue|set:"payout":$var.p_payout|set:"gross":$var.p_gross|set:"count":$var.p_count|set:"package_revenue":$var.p_pkg_revenue|set:"package_payout":$var.p_pkg_payout|set:"package_gross":$var.p_pkg_gross|set:"package_count":$var.p_pkg_count`
            }
          
            var.update $per_provider {
              value = `$var.per_provider|push:$var.p_row`
            }
          }
        }
      }
    }
  
    db.query services {
      return = {type: "list"}
    } as $all_services
  
    var $per_service {
      value = `[]`
    }
  
    foreach ($all_services) {
      each as $svc {
        var $s_revenue {
          value = `0`
        }
      
        var $s_gross {
          value = `0`
        }
      
        var $s_count {
          value = `0`
        }
      
        foreach ($annotated) {
          each as $a3 {
            conditional {
              if ($a3.service_id == $svc.id) {
                var.update $s_revenue {
                  value = `$var.s_revenue|add:$a3.cut`
                }
              
                var.update $s_gross {
                  value = `$var.s_gross|add:$a3.gross`
                }
              
                var.update $s_count {
                  value = `$var.s_count|add:1`
                }
              }
            }
          }
        }
      
        var $s_pkg_revenue {
          value = `0`
        }
      
        var $s_pkg_gross {
          value = `0`
        }
      
        var $s_pkg_sessions {
          value = `0`
        }
      
        foreach ($pkg_svc_ann) {
          each as $sa {
            conditional {
              if ($sa.service_id == $svc.id) {
                var.update $s_pkg_revenue {
                  value = `$var.s_pkg_revenue|add:$sa.revenue`
                }
              
                var.update $s_pkg_gross {
                  value = `$var.s_pkg_gross|add:$sa.gross`
                }
              
                var.update $s_pkg_sessions {
                  value = `$var.s_pkg_sessions|add:$sa.sessions`
                }
              }
            }
          }
        }
      
        var $s_row {
          value = `null`
        }
      
        conditional {
          if ($s_count > 0 || $s_pkg_sessions > 0 || $s_pkg_revenue > 0) {
            var.update $s_row {
              value = `{}|set:"service_id":$svc.id|set:"service_name":$svc.name|set:"revenue":$var.s_revenue|set:"gross":$var.s_gross|set:"count":$var.s_count|set:"package_revenue":$var.s_pkg_revenue|set:"package_gross":$var.s_pkg_gross|set:"package_sessions_sold":$var.s_pkg_sessions`
            }
          
            var.update $per_service {
              value = `$var.per_service|push:$var.s_row`
            }
          }
        }
      }
    }
  }

  response = {
    lifetime_revenue         : `$var.lifetime_revenue`
    month_revenue            : `$var.month_revenue`
    lifetime_gross           : `$var.lifetime_gross`
    lifetime_payouts         : `$var.lifetime_payouts`
    per_provider             : `$var.per_provider`
    per_service              : `$var.per_service`
    series                   : `$var.series`
    package_lifetime_revenue : `$var.pkgsum.lifetime_revenue`
    package_month_revenue    : `$var.pkgsum.month_revenue`
    package_lifetime_gross   : `$var.pkgsum.lifetime_gross`
    package_lifetime_payouts : `$var.pkgsum.lifetime_payouts`
    package_series           : `$var.pkgsum.series`
    combined_lifetime_revenue: `$var.combined_lifetime_revenue`
    combined_month_revenue   : `$var.combined_month_revenue`
  }
}