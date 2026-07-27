// POST /training-enrollments — PUBLIC. Spec 3.1.1.
// Validate + normalize, load course, COURSE_NOT_OPEN if status!=scheduled,
// capacity (paid < max_students) else COURSE_FULL, dedupe (course_id,email) else ALREADY_ENROLLED,
// insert enrollment (deposit_paid=false, snapshot deposit_amount, capture license_number),
// create PLATFORM-account deposit PaymentIntent (no transfer_data), save PI id, return {enrollment_id, client_secret}.
// NOTE: 409/410 error_types are unavailable in this workspace (per project memory) -> use badrequest with a CODE: prefix the frontend disambiguates on.
// NOTE: where-clauses reference $var (not $input) on purpose — the invite endpoint's $inputs.* where is the suspected cause of its non-firing idempotency check.
query "training-enrollments" verb=POST {
  api_group = "melanite_v1"

  input {
    text training_course_id filters=trim
    text first_name filters=trim
    text last_name filters=trim
    email email filters=trim|lower
    text phone filters=trim
    text license_number filters=trim
    text payment_option? filters=trim
  }

  stack {
    var $course_id {
      value = `$input.training_course_id`
    }
  
    db.get training_courses {
      field_name = "id"
      field_value = `$var.course_id`
    } as $course
  
    precondition (`$var.course` != null) {
      error_type = "notfound"
      error = "COURSE_NOT_FOUND: That training course does not exist."
    }
  
    precondition (`$var.course.status` == "scheduled") {
      error_type = "badrequest"
      error = "COURSE_NOT_OPEN: This course is not open for enrollment."
    }
  
    db.query training_enrollments {
      where = $db.training_enrollments.training_course_id == `$var.course_id` && $db.training_enrollments.deposit_paid == true
      return = {type: "list"}
    } as $paid_enrollments
  
    precondition (($paid_enrollments|count) < $course.max_students) {
      error_type = "badrequest"
      error = "COURSE_FULL: This course has no seats remaining."
    }
  
    db.query training_enrollments {
      where = $db.training_enrollments.training_course_id == `$var.course_id` && $db.training_enrollments.email == `$input.email`
      return = {type: "list"}
    } as $existing_enrollment
  
    precondition (($existing_enrollment|count) == 0) {
      error_type = "badrequest"
      error = "ALREADY_ENROLLED: This email is already enrolled in this course."
    }
  
    var $charge_amount {
      value = `$var.course.deposit_amount`
    }
  
    conditional {
      if ($input.payment_option == "full") {
        var.update $charge_amount {
          value = `$var.course.total_price`
        }
      }
    }
  
    db.add training_enrollments {
      enforce_hidden_fields = false
      data = {
        training_course_id: `$var.course_id`
        first_name        : `$input.first_name`
        last_name         : `$input.last_name`
        email             : `$input.email`
        phone             : `$input.phone`
        license_number    : `$input.license_number`
        deposit_paid      : false
        deposit_amount    : `$var.course.deposit_amount`
        balance_paid      : false
        amount_paid       : 0
        balance_due       : `$var.course.total_price`
        payment_status    : "unpaid"
        balance_due_date  : `$var.course.day1_date`
      }
    } as $enrollment
  
    var $amount_cents {
      value = `$var.charge_amount|multiply:100|to_int`
    }
  
    api.request {
      url = "https://api.stripe.com/v1/payment_intents"
      method = "POST"
      params = {}
        |set:"amount":`$var.amount_cents`
        |set:"currency":"usd"
        |set:'["payment_method_types[0]"]':"card"
        |set:'["payment_method_types[1]"]':"link"
        |set:'["metadata[training_enrollment_id]"]':`$var.enrollment.id`
        |set:'["metadata[type]"]':"training_deposit"
      headers = []
        |push:`"Authorization: Bearer "|concat:$env.STRIPE_SECRET_KEY`
        |push:`"Stripe-Version: "|concat:$env.STRIPE_API_VERSION`
        |push:"Content-Type: application/x-www-form-urlencoded"
    } as $pi_response
  
    db.edit training_enrollments {
      field_name = "id"
      field_value = `$var.enrollment.id`
      enforce_hidden_fields = false
      data = {
        stripe_deposit_payment_intent_id: `$var.pi_response.response.result.id`
      }
    } as $enrollment_updated
  }

  response = {
    enrollment_id: `$var.enrollment.id`
    client_secret: `$var.pi_response.response.result.client_secret`
  }
}