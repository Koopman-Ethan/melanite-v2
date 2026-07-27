// Update authenticated provider's profile. Used for onboarding Steps 2-4 (incremental save + complete_step transition) and post-onboarding profile edits.
// EXTENDED 2026-06-17 (spec 3.4.5): own-director path — md_* fields + medical_director_type whitelisted; self-satisfies the booking gate when director info is complete AND a supervision-agreement document is on file (no Stripe).
query me verb=PATCH {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text first_name? filters=trim
    text last_name? filters=trim
    text phone? filters=trim
    text credentials? filters=trim
    text license_number? filters=trim
    text license_state? filters=trim
    timestamp? license_expiry?
    text malpractice_insurance? filters=trim
    int complete_step?
    text medical_director_type? filters=trim
    text md_name? filters=trim
    text md_npi? filters=trim
    text md_license_number? filters=trim
    text md_license_state? filters=trim
    timestamp? md_license_expiry?
    text md_credentials? filters=trim
    text md_contact_email? filters=trim
    text md_contact_phone? filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$input.complete_step` == null || (`$input.complete_step` >= 2 && `$input.complete_step` <= 4)) {
      error_type = "badrequest"
      error = "Invalid step value. Must be 2, 3, or 4."
    }
  
    precondition (`$input.complete_step` == null || `$input.complete_step` <= ($var.provider.onboarding_step + 1)) {
      error_type = "badrequest"
      error = "Cannot skip onboarding steps."
    }
  
    precondition (`$input.complete_step` != 4 || `$var.provider.stripe_onboarding_complete`) {
      error_type = "badrequest"
      error = "Stripe Connect onboarding must be completed before advancing to Step 4."
    }
  
    db.edit providers {
      field_name = "id"
      field_value = `$var.provider.id`
      enforce_hidden_fields = false
      data = {
        first_name           : `$input.first_name|first_notempty:$var.provider.first_name`
        last_name            : `$input.last_name|first_notempty:$var.provider.last_name`
        phone                : `$input.phone|first_notempty:$var.provider.phone`
        credentials          : `$input.credentials|first_notempty:$var.provider.credentials`
        license_number       : `$input.license_number|first_notempty:$var.provider.license_number`
        license_state        : `$input.license_state|first_notempty:$var.provider.license_state`
        license_expiry       : `$input.license_expiry|first_notempty:$var.provider.license_expiry`
        malpractice_insurance: `$input.malpractice_insurance|first_notempty:$var.provider.malpractice_insurance`
        medical_director_type: `$input.medical_director_type|first_notempty:$var.provider.medical_director_type`
        md_name              : `$input.md_name|first_notempty:$var.provider.md_name`
        md_npi               : `$input.md_npi|first_notempty:$var.provider.md_npi`
        md_license_number    : `$input.md_license_number|first_notempty:$var.provider.md_license_number`
        md_license_state     : `$input.md_license_state|first_notempty:$var.provider.md_license_state`
        md_license_expiry    : `$input.md_license_expiry|first_notempty:$var.provider.md_license_expiry`
        md_credentials       : `$input.md_credentials|first_notempty:$var.provider.md_credentials`
        md_contact_email     : `$input.md_contact_email|first_notempty:$var.provider.md_contact_email`
        md_contact_phone     : `$input.md_contact_phone|first_notempty:$var.provider.md_contact_phone`
        onboarding_step      : `$input.complete_step|first_notempty:$var.provider.onboarding_step|max:$var.provider.onboarding_step`
      }
    } as $updated_provider
  
    conditional {
      if ($updated_provider.medical_director_type == "own" && $updated_provider.md_name != null && $updated_provider.md_npi != null && $updated_provider.md_license_number != null && $updated_provider.md_license_state != null && $updated_provider.md_license_expiry != null && $updated_provider.md_credentials != null && $updated_provider.md_contact_email != null && $updated_provider.md_contact_phone != null && $updated_provider.md_agreement_document_id != null) {
        db.edit providers {
          field_name = "id"
          field_value = `$var.updated_provider.id`
          enforce_hidden_fields = false
          data = {medical_director_status: "active"}
        } as $md_activate
      }
    }
  }

  response = {provider: `$var.updated_provider|unset:"password_hash"`}
}