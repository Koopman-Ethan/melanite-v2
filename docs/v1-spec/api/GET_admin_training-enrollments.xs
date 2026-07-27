// GET /admin/training-enrollments — ADMIN. Balance-collection admin panel (spec §6).
// List all training enrollments (newest first) with live payment fields so the admin
// panel can render per-enrollment Copy-balance-link / Resend-balance-email buttons.
query "admin/training-enrollments" verb=GET {
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
  
    db.query training_enrollments {
      where = $db.training_enrollments.created_at > 0
      return = {type: "list"}
    } as $enrollments
  }

  response = {enrollments: `$var.enrollments`}
}