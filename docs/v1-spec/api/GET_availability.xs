// GET /availability — provider JWT. Spec 3.2.1 (REVISED: GLOBAL, not per-provider).
// Single shared laser: any provider's booking blocks the slot for everyone.
// Generates candidate slots from platform_settings laser_open_time..laser_close_time at slot_stride_mins (Mountain Time),
// marks a slot unavailable if [slot_start, slot_start+duration) overlaps any booking with status upcoming|completed.
query availability verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text date filters=trim
    int duration_mins
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition ($input.duration_mins > 0) {
      error_type = "badrequest"
      error = "INVALID_DURATION: duration_mins must be a positive integer."
    }
  
    db.get platform_settings {
      field_name = "id"
      field_value = 1
    } as $settings
  
    var $open_str {
      value = `$input.date|concat:$var.settings.laser_open_time:" "`
    }
  
    var $close_str {
      value = `$input.date|concat:$var.settings.laser_close_time:" "`
    }
  
    var $open_ts {
      value = `$var.open_str|parse_timestamp:"Y-m-d H:i":"America/Denver"`
    }
  
    var $close_ts {
      value = `$var.close_str|parse_timestamp:"Y-m-d H:i":"America/Denver"`
    }
  
    precondition ($close_ts > now) {
      error_type = "badrequest"
      error = "DATE_IN_PAST: date must be today or later."
    }
  
    var $stride_secs {
      value = `$var.settings.slot_stride_mins|multiply:60`
    }
  
    var $duration_secs {
      value = `$input.duration_mins|multiply:60`
    }
  
    var $n_slots {
      value = `$var.close_ts|subtract:$var.open_ts|divide:1000|divide:$var.stride_secs|to_int`
    }
  
    db.query bookings {
      where = $db.bookings.end_time > `$var.open_ts` && $db.bookings.start_time < `$var.close_ts` && ($db.bookings.status == "upcoming" || $db.bookings.status == "completed")
      return = {type: "list"}
    } as $day_bookings
  
    var $slots {
      value = `[]`
    }
  
    for ($n_slots) {
      each as $i {
        var $offset_secs {
          value = `$i|multiply:$var.stride_secs`
        }
      
        var $slot_start {
          value = `$var.open_ts|add_secs_to_timestamp:$var.offset_secs`
        }
      
        var $slot_end {
          value = `$var.slot_start|add_secs_to_timestamp:$var.duration_secs`
        }
      
        var $available {
          value = true
        }
      
        conditional {
          if ($slot_end > $close_ts) {
            var.update $available {
              value = false
            }
          }
        }
      
        conditional {
          if ($slot_start <= now) {
            var.update $available {
              value = false
            }
          }
        }
      
        foreach ($day_bookings) {
          each as $bk {
            conditional {
              if ($bk.start_time < $slot_end && $bk.end_time > $slot_start) {
                var.update $available {
                  value = false
                }
              }
            }
          }
        }
      
        var $slot_obj {
          value = `{}|set:"start_time":$var.slot_start|set:"available":$var.available`
        }
      
        var.update $slots {
          value = `$var.slots|push:$var.slot_obj`
        }
      }
    }
  }

  response = {date: `$input.date`, slots: `$var.slots`}
}