// POST /admin/training-courses/{id}/mark-complete — ADMIN. Spec 3.1.3.
// Flip course status=completed and stamp course_completed_at=now on every enrollment
// of that course. NO auto-invite (Keoni issues the standard provider invite separately).
query "admin/training-courses/{id}/mark-complete" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text id filters=trim
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
  
    db.edit training_courses {
      field_name = "id"
      field_value = `$var.course_id`
      enforce_hidden_fields = false
      data = {status: "completed"}
    } as $updated_course
  
    db.query training_enrollments {
      where = $db.training_enrollments.training_course_id == `$var.course_id`
      return = {type: "list"}
    } as $enrollments
  
    foreach ($enrollments) {
      each as $enr {
        db.edit training_enrollments {
          field_name = "id"
          field_value = `$var.enr.id`
          enforce_hidden_fields = false
          data = {course_completed_at: now}
        } as $enr_updated
      }
    }
  }

  response = {
    course             : `$var.updated_course`
    enrollments_stamped: `$var.enrollments|count`
  }
}