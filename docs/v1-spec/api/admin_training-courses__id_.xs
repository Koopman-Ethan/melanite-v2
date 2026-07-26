// PATCH /admin/training-courses/{id} — ADMIN. Spec 3.1.3.
// Edit a course. All editable fields optional; only provided (non-null) fields change
// (first_notempty preserves current values). LOCK: once any PAID enrollment exists,
// reject attempts to change dates or money fields (day1_date, day2_date, deposit_amount,
// total_price) with COURSE_HAS_PAID_ENROLLMENTS. Times / max_students / status stay editable.
query "admin/training-courses/{id}" verb=PATCH {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text id filters=trim
    text day1_date? filters=trim
    text day1_start? filters=trim
    text day1_end? filters=trim
    text day2_date? filters=trim
    text day2_start? filters=trim
    text day2_end? filters=trim
    int max_students?
    decimal deposit_amount?
    decimal total_price?
    text status? filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$var.provider.is_admin`) {
      error_type = "accessdenied"
      error = "ADMIN_ONLY: Admin access required."
    }
  
    var $course_id {
      value = `$input.id`
    }
  
    db.get training_courses {
      field_name = "id"
      field_value = `$var.course_id`
    } as $course
  
    precondition (`$var.course` != null) {
      error_type = "notfound"
      error = "COURSE_NOT_FOUND: That training course does not exist."
    }
  
    db.query training_enrollments {
      where = $db.training_enrollments.training_course_id == `$var.course_id` && $db.training_enrollments.deposit_paid == true
      return = {type: "list"}
    } as $paid_enrollments
  
    var $paid_count {
      value = `$var.paid_enrollments|count`
    }
  
    conditional {
      if ($paid_count > 0) {
        precondition (`$input.day1_date` == null) {
          error_type = "badrequest"
          error = "COURSE_HAS_PAID_ENROLLMENTS: Cannot change dates once paid enrollments exist."
        }
      
        precondition (`$input.day2_date` == null) {
          error_type = "badrequest"
          error = "COURSE_HAS_PAID_ENROLLMENTS: Cannot change dates once paid enrollments exist."
        }
      
        precondition (`$input.deposit_amount` == null) {
          error_type = "badrequest"
          error = "COURSE_HAS_PAID_ENROLLMENTS: Cannot change deposit amount once paid enrollments exist."
        }
      
        precondition (`$input.total_price` == null) {
          error_type = "badrequest"
          error = "COURSE_HAS_PAID_ENROLLMENTS: Cannot change total price once paid enrollments exist."
        }
      }
    }
  
    db.edit training_courses {
      field_name = "id"
      field_value = `$var.course_id`
      enforce_hidden_fields = false
      data = {
        day1_date     : `$input.day1_date|first_notempty:$var.course.day1_date`
        day1_start    : `$input.day1_start|first_notempty:$var.course.day1_start`
        day1_end      : `$input.day1_end|first_notempty:$var.course.day1_end`
        day2_date     : `$input.day2_date|first_notempty:$var.course.day2_date`
        day2_start    : `$input.day2_start|first_notempty:$var.course.day2_start`
        day2_end      : `$input.day2_end|first_notempty:$var.course.day2_end`
        max_students  : `$input.max_students|first_notempty:$var.course.max_students`
        deposit_amount: `$input.deposit_amount|first_notempty:$var.course.deposit_amount`
        total_price   : `$input.total_price|first_notempty:$var.course.total_price`
        status        : `$input.status|first_notempty:$var.course.status`
      }
    } as $updated
  }

  response = {course: `$var.updated`}
}