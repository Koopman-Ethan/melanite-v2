// GET /packages/templates/{template_id} — FET-01 Phase 1. One template + line items,
// ownership-scoped (a provider can only read their own).
query "packages/templates/{template_id}" verb=GET {
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
  
    db.query package_template_items {
      where = $db.package_template_items.package_template_id == `$var.tpl.id`
      return = {type: "list"}
    } as $tpl_items
  }

  response = {template: `$var.tpl`, items: `$var.tpl_items`}
}