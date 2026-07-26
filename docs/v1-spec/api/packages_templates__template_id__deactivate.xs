// POST /packages/templates/{template_id}/deactivate — FET-01 Phase 1. Soft delete.
// WIPE-BUG LESSON (2026-07-22): db.edit on package_templates NULLS any nullable
// column omitted from data — so this writes the FULL row (current values + active=false).
// NEVER hard-delete a template — purchased packages reference them from Phase 2 on.
// Reactivate via PATCH {active: true}.
query "packages/templates/{template_id}/deactivate" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text template_id filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.get package_templates {
      field_name = "id"
      field_value = `$input.template_id`
    } as $tpl
  
    precondition ($tpl != null) {
      error_type = "notfound"
      error = "TEMPLATE_NOT_FOUND: That package template does not exist."
    }
  
    precondition ($tpl.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "TEMPLATE_NOT_FOUND: That package template does not belong to you."
    }
  
    db.edit package_templates {
      field_name = "id"
      field_value = `$var.tpl.id`
      enforce_hidden_fields = false
      data = {
        name              : `$var.tpl.name`
        description       : `$var.tpl.description`
        total_price       : `$var.tpl.total_price`
        expires_after_days: `$var.tpl.expires_after_days`
        active            : false
      }
    } as $tpl_deactivated
  
    db.get package_templates {
      field_name = "id"
      field_value = `$var.tpl.id`
    } as $tpl_fresh
  }

  response = {template: `$var.tpl_fresh`}
}