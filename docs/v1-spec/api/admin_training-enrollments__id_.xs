// PATCH /admin/training-enrollments/{id} — ADMIN. Spec 3.1.4.
// Manual admin overrides: mark balance_paid true, and/or link an invite_link_id
// (after Keoni issues the standard provider invite). Only provided fields change.
// NOTE: first_notempty means you can't flip balance_paid back to false via this endpoint
// (false reads as empty -> falls through to current). Setting-to-true is the spec'd use.
query "admin/training-enrollments/{id}" verb=PATCH {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text id filters=trim
    bool balance_paid?
    text invite_link_id? filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$var.provider.is_admin`) {
      error_type = "accessdenied"
      error = "ADMIN_ONLY: Admin access required."
    }
  
    db.get training_enrollments {
      field_name = "id"
      field_value = `$input.id`
    } as $enrollment
  
    precondition (`$var.enrollment` != null) {
      error_type = "notfound"
      error = "ENROLLMENT_NOT_FOUND: That enrollment does not exist."
    }
  
    db.edit training_enrollments {
      field_name = "id"
      field_value = `$input.id`
      enforce_hidden_fields = false
      data = {
        balance_paid  : `$input.balance_paid|first_notempty:$var.enrollment.balance_paid`
        invite_link_id: `$input.invite_link_id|first_notempty:$var.enrollment.invite_link_id`
      }
    } as $updated
  }

  response = {enrollment: `$var.updated`}
}