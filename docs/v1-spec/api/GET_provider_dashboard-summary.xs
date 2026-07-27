// GET /provider/dashboard-summary — provider JWT. Spec 3.3.3.
// Lean rollup the home page calls on load: this-month earnings (SUM provider_payout, MT),
// next 5 upcoming appointments (annotated with service name + pay-link status), pending
// checkout-links count, med-director status for the gate banner. Empty state = zeros / [].
query "provider/dashboard-summary" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    var $cur_month {
      value = `now|format_timestamp:"Y-m":"America/Denver"`
    }
  
    db.query transactions {
      where = $db.transactions.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $txns
  
    var $month_earnings {
      value = `0`
    }
  
    var $pending_payout {
      value = `0`
    }
  
    foreach ($txns) {
      each as $txn {
        var $txn_month {
          value = `$txn.created_at|format_timestamp:"Y-m":"America/Denver"`
        }
      
        conditional {
          if ($txn_month == $cur_month) {
            var.update $month_earnings {
              value = `$var.month_earnings|add:$txn.provider_payout`
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
      }
    }
  
    db.query bookings {
      where = $db.bookings.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $my_bookings
  
    var $upcoming {
      value = `[]`
    }
  
    var $upcoming_count {
      value = `0`
    }
  
    var $pending_links {
      value = `0`
    }
  
    foreach ($my_bookings) {
      each as $bk {
        conditional {
          if ($bk.status == "upcoming" && $bk.start_time > now) {
            db.query checkout_links {
              where = $db.checkout_links.booking_id == `$bk.id`
              return = {type: "list"}
            } as $links
          
            var $pay_status {
              value = `null`
            }
          
            foreach ($links) {
              each as $lnk {
                var.update $pay_status {
                  value = `$lnk.status`
                }
              
                conditional {
                  if ($lnk.status == "pending") {
                    var.update $pending_links {
                      value = `$var.pending_links|add:1`
                    }
                  }
                }
              }
            }
          
            conditional {
              if ($upcoming_count < 5) {
                db.get provider_services {
                  field_name = "id"
                  field_value = `$bk.provider_service_id`
                } as $ps
              
                db.get services {
                  field_name = "id"
                  field_value = `$var.ps.service_id`
                } as $svc
              
                var $row {
                  value = `{}|set:"id":$bk.id|set:"start_time":$bk.start_time|set:"end_time":$bk.end_time|set:"client_name":$bk.client_name|set:"treatment_area":$bk.treatment_area|set:"price":$bk.price|set:"service_name":$var.svc.name|set:"payment_status":$var.pay_status`
                }
              
                var.update $upcoming {
                  value = `$var.upcoming|push:$var.row`
                }
              
                var.update $upcoming_count {
                  value = `$var.upcoming_count|add:1`
                }
              }
            }
          }
        }
      }
    }
  }

  response = {
    month_earnings         : `$var.month_earnings`
    pending_payout         : `$var.pending_payout`
    upcoming_appointments  : `$var.upcoming`
    pending_links_count    : `$var.pending_links`
    medical_director_status: `$var.provider.medical_director_status`
    first_name             : `$var.provider.first_name`
  }
}