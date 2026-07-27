// PATCH /providers/{provider_id} — provider JWT. Spec §Provider Profile 1.
// Post-onboarding ACCOUNT edit (distinct from onboarding-only PATCH /me).
// Editable: first/last name, phone, credentials, malpractice, email (uniqueness-checked),
// password (current-password verified), + 5 notification-preference booleans.
// License fields are READ-ONLY post-onboarding -> rejected with FORBIDDEN_FIELD.
// Booleans use explicit null-checks (first_notempty cannot set a boolean back to false).
// Password is written in a SEPARATE db.edit only when changing — writing the existing
// hash back into a password-type field would re-bcrypt and corrupt the login.
query "providers/{provider_id}" verb=PATCH {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text provider_id filters=trim
    text first_name? filters=trim
    text last_name? filters=trim
    text phone? filters=trim
    text credentials? filters=trim
    text malpractice_insurance? filters=trim
    email email? filters=trim|lower
    text current_password?
    text new_password?
    bool? notify_booking_confirmed?
    bool? notify_payout_deposited?
    bool? notify_appointment_reminders?
    bool? notify_new_availability?
    bool? notify_membership_billing?
  
    // license_* accepted ONLY to detect & reject (read-only post-onboarding)
    text license_number?
  
    text license_state?
    text license_expiry?
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    // Ownership — URL :id must match the caller.
    precondition ($input.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "FORBIDDEN: You can only edit your own account."
    }
  
    // Reject read-only license fields.
    precondition ($input.license_number == null && $input.license_state == null && $input.license_expiry == null) {
      error_type = "accessdenied"
      error = "FORBIDDEN_FIELD: License fields are read-only. Contact Keoni to update license info."
    }
  
    // Fresh full row (need password_hash + current notification values).
    db.get providers {
      field_name = "id"
      field_value = `$var.provider.id`
    } as $current
  
    // ---- Email change: uniqueness (exclude self) ----
    var $new_email {
      value = `$var.current.email`
    }
  
    conditional {
      if ($input.email != null && $input.email != $current.email) {
        db.get providers {
          field_name = "email"
          field_value = `$input.email`
        } as $email_owner
      
        precondition ($email_owner == null || $email_owner.id == $provider.id) {
          error_type = "badrequest"
          error = "EMAIL_TAKEN: That email address is already in use."
        }
      
        var.update $new_email {
          value = `$input.email`
        }
      }
    }
  
    // ---- Password change validation ----
    var $pass_ok {
      value = true
    }
  
    conditional {
      if ($input.new_password != null) {
        security.check_password {
          text_password = `$input.current_password|first_notempty:""`
          hash_password = `$var.current.password_hash`
        } as $pw_check
      
        var.update $pass_ok {
          value = `$pw_check`
        }
      }
    }
  
    precondition ($input.new_password == null || $input.current_password != null) {
      error_type = "badrequest"
      error = "CURRENT_PASSWORD_REQUIRED: Enter your current password to set a new one."
    }
  
    precondition ($input.new_password == null || $pass_ok) {
      error_type = "accessdenied"
      error = "CURRENT_PASSWORD_WRONG: Your current password is incorrect."
    }
  
    precondition ($input.new_password == null || ($input.new_password|strlen) >= 12) {
      error_type = "badrequest"
      error = "WEAK_PASSWORD: Password must be at least 12 characters."
    }
  
    // ---- Notification booleans (explicit null-check; first_notempty can't set false) ----
    var $n_booking {
      value = `$var.current.notify_booking_confirmed`
    }
  
    conditional {
      if ($input.notify_booking_confirmed !== null) {
        var.update $n_booking {
          value = `$input.notify_booking_confirmed`
        }
      }
    }
  
    var $n_payout {
      value = `$var.current.notify_payout_deposited`
    }
  
    conditional {
      if ($input.notify_payout_deposited !== null) {
        var.update $n_payout {
          value = `$input.notify_payout_deposited`
        }
      }
    }
  
    var $n_reminders {
      value = `$var.current.notify_appointment_reminders`
    }
  
    conditional {
      if ($input.notify_appointment_reminders !== null) {
        var.update $n_reminders {
          value = `$input.notify_appointment_reminders`
        }
      }
    }
  
    var $n_availability {
      value = `$var.current.notify_new_availability`
    }
  
    conditional {
      if ($input.notify_new_availability !== null) {
        var.update $n_availability {
          value = `$input.notify_new_availability`
        }
      }
    }
  
    var $n_billing {
      value = `$var.current.notify_membership_billing`
    }
  
    conditional {
      if ($input.notify_membership_billing !== null) {
        var.update $n_billing {
          value = `$input.notify_membership_billing`
        }
      }
    }
  
    // ---- Writes: only touch fields actually provided (avoids multi-field DB wipe) ----
    conditional {
      if (($input.first_name|strlen) > 0) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {first_name: `$input.first_name`}
        }
      }
    }
  
    conditional {
      if (($input.last_name|strlen) > 0) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {last_name: `$input.last_name`}
        }
      }
    }
  
    conditional {
      if (($input.phone|strlen) > 0) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {phone: `$input.phone`}
        }
      }
    }
  
    conditional {
      if (($input.credentials|strlen) > 0) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {credentials: `$input.credentials`}
        }
      }
    }
  
    conditional {
      if (($input.malpractice_insurance|strlen) > 0) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {malpractice_insurance: `$input.malpractice_insurance`}
        }
      }
    }
  
    conditional {
      if (($input.email|strlen) > 0 && $input.email != $provider.email) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {email: `$input.email`}
        }
      }
    }
  
    conditional {
      if ($input.notify_booking_confirmed != null) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {
            notify_booking_confirmed: `$input.notify_booking_confirmed`
          }
        }
      }
    }
  
    conditional {
      if ($input.notify_payout_deposited != null) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {notify_payout_deposited: `$input.notify_payout_deposited`}
        }
      }
    }
  
    conditional {
      if ($input.notify_appointment_reminders != null) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {
            notify_appointment_reminders: `$input.notify_appointment_reminders`
          }
        }
      }
    }
  
    conditional {
      if ($input.notify_new_availability != null) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {notify_new_availability: `$input.notify_new_availability`}
        }
      }
    }
  
    conditional {
      if ($input.notify_membership_billing != null) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {
            notify_membership_billing: `$input.notify_membership_billing`
          }
        }
      }
    }
  
    conditional {
      if ($input.new_password != null) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          data = {password_hash: `$input.new_password`}
        }
      }
    }
  
    db.get providers {
      field_name = "id"
      field_value = `$var.provider.id`
    } as $updated
  }

  response = {provider: `$var.updated|unset:"password_hash"`}
}