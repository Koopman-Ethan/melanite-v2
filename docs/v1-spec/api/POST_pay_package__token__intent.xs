// POST /pay/package/{token}/intent — FET-01 Phase 2 (+4b Part D client_name). WIPE RULE: full-row link edit.
query "pay/package/{token}/intent" verb=POST {
  api_group = "melanite_v1"

  input {
    text token filters=trim
    decimal? tip_amount?=0
    text? client_email? filters=trim|lower
    text? client_name? filters=trim
  }

  stack {
    var $tok {
      value = `$input.token`
    }
  
    db.get package_checkout_links {
      field_name = "token"
      field_value = `$var.tok`
    } as $link
  
    precondition ($link != null) {
      error_type = "notfound"
      error = "LINK_NOT_FOUND: That payment link does not exist."
    }
  
    precondition ($link.status == "pending") {
      error_type = "badrequest"
      error = "LINK_NOT_PAYABLE: This payment link is no longer payable."
    }
  
    precondition ($link.expires_at > now) {
      error_type = "badrequest"
      error = "LINK_EXPIRED: This payment link has expired."
    }
  
    db.get platform_settings {
      field_name = "id"
      field_value = 1
    } as $settings
  
    precondition ($settings.packages_enabled) {
      error_type = "accessdenied"
      error = "PACKAGES_DISABLED: Package sales are not enabled yet."
    }
  
    var $tip {
      value = `$input.tip_amount|first_notempty:0`
    }
  
    precondition ($tip >= 0) {
      error_type = "badrequest"
      error = "INVALID_TIP: tip_amount cannot be negative."
    }
  
    db.get package_templates {
      field_name = "id"
      field_value = `$var.link.package_template_id`
    } as $tpl
  
    precondition ($tpl != null) {
      error_type = "notfound"
      error = "TEMPLATE_NOT_FOUND: The package on this link no longer exists."
    }
  
    precondition (`$var.tpl.active`) {
      error_type = "badrequest"
      error = "TEMPLATE_INACTIVE: This package is no longer offered."
    }
  
    db.get providers {
      field_name = "id"
      field_value = `$var.link.provider_id`
    } as $prov
  
    precondition ($prov.stripe_account_id != null) {
      error_type = "badrequest"
      error = "PROVIDER_NOT_PAYABLE: The provider cannot accept payments yet."
    }
  
    var $platform_pct {
      value = `1|subtract:$var.settings.provider_share_pct`
    }
  
    var $amount_cents {
      value = `$var.tpl.total_price|add:$var.tip|multiply:100|round|to_int`
    }
  
    var $fee_cents {
      value = `$var.tpl.total_price|multiply:$var.platform_pct|multiply:100|round|to_int`
    }
  
    var $cemail {
      value = `$var.link.client_email`
    }
  
    conditional {
      if (($input.client_email|strlen) > 0) {
        var.update $cemail {
          value = `$input.client_email`
        }
      }
    }
  
    var $cname {
      value = `$var.link.client_name`
    }
  
    conditional {
      if (($input.client_name|strlen) > 0) {
        var.update $cname {
          value = `$input.client_name`
        }
      }
    }
  
    api.request {
      url = "https://api.stripe.com/v1/payment_intents"
      method = "POST"
      params = {}
        |set:"amount":`$var.amount_cents`
        |set:"currency":"usd"
        |set:'["automatic_payment_methods[enabled]"]':"true"
        |set:'["transfer_data[destination]"]':`$var.prov.stripe_account_id`
        |set:"application_fee_amount":`$var.fee_cents`
        |set:'["metadata[type]"]':"package_purchase"
        |set:'["metadata[package_checkout_link_id]"]':`$var.link.id`
        |set:'["metadata[package_template_id]"]':`$var.tpl.id`
        |set:'["metadata[provider_id]"]':`$var.prov.id`
        |set:'["metadata[client_email]"]':`$var.cemail`
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY_PKG`
        |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
        |push:"Content-Type: application/x-www-form-urlencoded"
    } as $pi_response
  
    db.edit package_checkout_links {
      field_name = "id"
      field_value = `$var.link.id`
      enforce_hidden_fields = false
      data = {
        token                   : `$var.link.token`
        package_template_id     : `$var.link.package_template_id`
        provider_id             : `$var.link.provider_id`
        client_email            : `$var.cemail`
        client_name             : `$var.cname`
        status                  : "pending"
        tip_amount              : `$var.tip`
        stripe_customer_id      : `$var.link.stripe_customer_id`
        stripe_payment_intent_id: `$var.pi_response.response.result.id`
        paid_at                 : `$var.link.paid_at`
        expires_at              : `$var.link.expires_at`
      }
    } as $link_updated
  }

  response = {
    client_secret: `$var.pi_response.response.result.client_secret`
  }
}