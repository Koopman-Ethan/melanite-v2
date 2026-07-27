// POST /admin/training-courses — ADMIN. Spec 3.1.3.
// Create a 2-day training course. status defaults to "scheduled".
// gcal event ids are left null (no calendar integration for July 8).
// Date inputs declared as text (ISO yyyy-mm-dd) -> Xano coerces into the date fields;
// confirm at runtime that the stored date matches (switch to `timestamp` if not).
query "admin/training-courses" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text day1_date filters=trim
    text day1_start filters=trim
    text day1_end filters=trim
    text day2_date filters=trim
    text day2_start filters=trim
    text day2_end filters=trim
    int max_students
    decimal deposit_amount
    decimal total_price
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$var.provider.is_admin`) {
      error_type = "accessdenied"
      error = "ADMIN_ONLY: Admin access required."
    }
  
    db.add training_courses {
      enforce_hidden_fields = false
      data = {
        day1_date     : `$input.day1_date`
        day1_start    : `$input.day1_start`
        day1_end      : `$input.day1_end`
        day2_date     : `$input.day2_date`
        day2_start    : `$input.day2_start`
        day2_end      : `$input.day2_end`
        max_students  : `$input.max_students`
        deposit_amount: `$input.deposit_amount`
        total_price   : `$input.total_price`
        status        : "scheduled"
      }
    } as $course
  }

  response = {course: `$var.course`}
}