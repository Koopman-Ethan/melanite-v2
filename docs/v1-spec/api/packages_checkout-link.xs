// POST /packages/checkout-link — FET-01 Phase 2 (+4b Part D client_name).
query "packages/checkout-link" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text template_id filters=trim
    text? client_email? filters=trim|lower
    text? client_name? filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.get platform_settings {
      field_name = "id"
      field_value = 1
    } as $settings
  
    precondition ($settings.packages_enabled) {
      error_type = "accessdenied"
      error = "PACKAGES_DISABLED: Package sales are not enabled yet."
    }
  
    precondition ($provider.stripe_account_id != null) {
      error_type = "badrequest"
      error = "PROVIDER_NOT_PAYABLE: Finish your Stripe payout setup before selling packages."
    }
  
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
  
    precondition (`$var.tpl.active`) {
      error_type = "badrequest"
      error = "TEMPLATE_INACTIVE: Reactivate this template before selling it."
    }
  
    security.create_uuid as $tok1
    security.create_uuid as $tok2
    var $token {
      value = `$var.tok1|concat:$var.tok2:"-"`
    }
  
    var $expires_at {
      value = `now|add_secs_to_timestamp:604800`
    }
  
    var $cemail {
      value = `$input.client_email|first_notempty:""`
    }
  
    var $cname {
      value = `$input.client_name|first_notempty:""`
    }
  
    db.add package_checkout_links {
      enforce_hidden_fields = false
      data = {
        token              : `$var.token`
        package_template_id: `$var.tpl.id`
        provider_id        : `$var.provider.id`
        client_email       : `$var.cemail`
        client_name        : `$var.cname`
        status             : "pending"
        tip_amount         : 0
        expires_at         : `$var.expires_at`
      }
    } as $pkg_link
  
    var $pay_url {
      value = `$env.APP_BASE_URL|concat:"/pay/package/"|concat:$var.token`
    }
  
    var $link_response {
      value = `{}|set:"id":$var.pkg_link.id|set:"token":$var.token|set:"url":$var.pay_url|set:"expires_at":$var.expires_at|set:"client_email":$var.cemail|set:"client_name":$var.cname`
    }
  }

  response = {checkout_link: `$var.link_response`}
}