// GET /admin/training-courses — ADMIN. Spec 3.1.3.
// List all courses (sorted by day1_date), each annotated with:
//   enrollment_count = total enrollments for the course
//   paid_count       = enrollments with deposit_paid=true
// Admin auth = providers JWT + is_admin gate (canonical pattern from POST /admin/providers/invite).
query "admin/training-courses" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition (`$var.provider.is_admin`) {
      error_type = "accessdenied"
      error = "ADMIN_ONLY: Admin access required."
    }
  
    db.query training_courses {
      return = {type: "list"}
    } as $courses
  
    var $result {
      value = `[]`
    }
  
    foreach ($courses) {
      each as $course {
        var $course_id {
          value = `$var.course.id`
        }
      
        db.query training_enrollments {
          where = $db.training_enrollments.training_course_id == `$var.course_id`
          return = {type: "list"}
        } as $all_enrollments
      
        db.query training_enrollments {
          where = $db.training_enrollments.training_course_id == `$var.course_id` && $db.training_enrollments.deposit_paid == true
          return = {type: "list"}
        } as $paid_enrollments
      
        var $total_count {
          value = `$var.all_enrollments|count`
        }
      
        var $paid_count {
          value = `$var.paid_enrollments|count`
        }
      
        var $row {
          value = `$var.course`
        }
      
        var.update $row {
          value = `$var.row|set:"enrollment_count":$var.total_count`
        }
      
        var.update $row {
          value = `$var.row|set:"paid_count":$var.paid_count`
        }
      
        var.update $result {
          value = `$var.result|push:$var.row`
        }
      }
    }
  }

  response = {courses: `$var.result`}
}