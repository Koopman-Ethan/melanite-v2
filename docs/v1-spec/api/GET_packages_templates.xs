// GET /packages/templates — FET-01 Phase 1. The calling provider's templates
// (ACTIVE AND INACTIVE — the builder UI needs both; Phase 2's sell flow filters
// to active server-side), each with its line items attached.
query "packages/templates" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query package_templates {
      where = $db.package_templates.provider_id == `$var.provider.id`
      sort = {created_at: "desc"}
      return = {type: "list"}
    } as $templates
  
    var $out {
      value = `[]`
    }
  
    foreach ($templates) {
      each as $tpl {
        db.query package_template_items {
          where = $db.package_template_items.package_template_id == `$tpl.id`
          return = {type: "list"}
        } as $tpl_items
      
        var $entry {
          value = `$tpl|set:"items":$var.tpl_items`
        }
      
        var.update $out {
          value = `$var.out|push:$var.entry`
        }
      }
    }
  }

  response = {templates: `$var.out`}
}