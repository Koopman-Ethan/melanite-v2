// GET /training-enrollments/{id} — PUBLIC. Spec 3.1.2.
// Post-payment landing data. Exposes only first_name + course schedule + payment status
// (NOT email/last_name/phone/license) since the UUID id is the only access control.
// 2026-07-06: extended with amount_paid/balance_due/payment_status/balance_due_date for the /training-balance page.
query "training-enrollments/{id}" verb=GET {
  api_group = "melanite_v1"

  input {
    text id filters=trim
  }

  stack {
    db.get training_enrollments {
      field_name = "id"
      field_value = `$input.id`
    } as $enrollment
  
    precondition (`$var.enrollment` != null) {
      error_type = "notfound"
      error = "ENROLLMENT_NOT_FOUND: That enrollment does not exist."
    }
  
    db.get training_courses {
      field_name = "id"
      field_value = `$var.enrollment.training_course_id`
    } as $course
  }

  response = {
    first_name      : `$var.enrollment.first_name`
    day1_date       : `$var.course.day1_date`
    day1_start      : `$var.course.day1_start`
    day1_end        : `$var.course.day1_end`
    day2_date       : `$var.course.day2_date`
    day2_start      : `$var.course.day2_start`
    day2_end        : `$var.course.day2_end`
    deposit_amount  : `$var.enrollment.deposit_amount`
    total_price     : `$var.course.total_price`
    deposit_paid    : `$var.enrollment.deposit_paid`
    balance_paid    : `$var.enrollment.balance_paid`
    amount_paid     : `$var.enrollment.amount_paid`
    balance_due     : `$var.enrollment.balance_due`
    payment_status  : `$var.enrollment.payment_status`
    balance_due_date: `$var.enrollment.balance_due_date`
  }
}