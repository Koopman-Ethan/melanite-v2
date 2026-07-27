// GET /appointments/{booking_id} — provider JWT. Spec 3.2.3 detail view.
// Scoped to caller; joins the booking's checkout_link and transaction (null until paid).
query "appointments/{booking_id}" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text booking_id filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    var $bk_id {
      value = `$input.booking_id`
    }
  
    db.get bookings {
      field_name = "id"
      field_value = `$var.bk_id`
    } as $booking
  
    precondition ($booking != null) {
      error_type = "notfound"
      error = "BOOKING_NOT_FOUND: That booking does not exist."
    }
  
    precondition ($booking.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "BOOKING_NOT_FOUND: That booking does not belong to you."
    }
  
    db.query checkout_links {
      where = $db.checkout_links.booking_id == `$var.bk_id`
      return = {type: "list"}
    } as $links
  
    var $checkout_link {
      value = `$var.links.0`
    }
  
    db.query transactions {
      where = $db.transactions.booking_id == `$var.bk_id`
      return = {type: "list"}
    } as $txns
  
    var $transaction {
      value = `$var.txns.0`
    }
  }

  response = {
    booking      : `$var.booking`
    checkout_link: `$var.checkout_link`
    transaction  : `$var.transaction`
  }
}