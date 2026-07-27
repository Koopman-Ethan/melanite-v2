// DELETE /providers/{provider_id} — provider JWT. Spec §Provider Profile 2.
// SOFT-delete: sets status='inactive' (row preserved for compliance/audit/tax). Wired to BOTH
// the Deactivate and Delete Account buttons — we never hard-delete.
// Guards (block deactivation): any upcoming future booking; any pending payout.
// Cancels any ACTIVE Melanite medical-director subscription at period end (non-fatal on Stripe error).
query "providers/{provider_id}" verb=DELETE {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text provider_id filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition ($input.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "FORBIDDEN: You can only deactivate your own account."
    }
  
    // Guard 1 — upcoming bookings.
    db.query bookings {
      where = $db.bookings.provider_id == `$var.provider.id` && $db.bookings.status == "upcoming" && $db.bookings.start_time > now
      return = {type: "list"}
    } as $upcoming
  
    precondition (($upcoming|count) == 0) {
      error_type = "badrequest"
      error = "UPCOMING_BOOKINGS_BLOCK_DELETE: You have upcoming bookings. Cancel or complete them before deactivating."
    }
  
    // Guard 2 — pending payouts.
    db.query transactions {
      where = $db.transactions.provider_id == `$var.provider.id` && $db.transactions.payout_status == "pending"
      return = {type: "list"}
    } as $pending_payouts
  
    precondition (($pending_payouts|count) == 0) {
      error_type = "badrequest"
      error = "PENDING_PAYOUTS_BLOCK_DELETE: You have payouts still settling. They must clear before deactivating."
    }
  
    // Cancel active membership subscription(s) at period end (non-fatal).
    db.query memberships {
      where = $db.memberships.provider_id == `$var.provider.id` && $db.memberships.status == "active"
      return = {type: "list"}
    } as $active_memberships
  
    foreach ($active_memberships) {
      each as $mem {
        conditional {
          if ($mem.stripe_subscription_id != null) {
            api.request {
              url = `"https://api.stripe.com/v1/subscriptions/"|concat:$mem.stripe_subscription_id`
              method = "POST"
              params = {}
                |set:"cancel_at_period_end":"true"
              headers = []
                |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
                |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
                |push:"Content-Type: application/x-www-form-urlencoded"
            } as $cancel_resp
          }
        }
      
        db.edit memberships {
          field_name = "id"
          field_value = `$mem.id`
          enforce_hidden_fields = false
          data = {cancel_at_period_end: true, cancel_date: `now`}
        } as $mem_updated
      }
    }
  
    // Soft-delete the provider.
    db.edit providers {
      field_name = "id"
      field_value = `$var.provider.id`
      enforce_hidden_fields = false
      data = {status: "inactive"}
    } as $deactivated
  }

  response = {status: "inactive", deactivated_at: `now`}
}