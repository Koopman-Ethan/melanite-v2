// GET /training-courses/upcoming — PUBLIC. Spec 4.1 support endpoint.
// Returns the SINGLE soonest status=scheduled course (no auth) for the /laser-training page.
// "One course at a time" locked decision (Keoni reschedules by pushing the one course out),
// so the page shows one course + seats; no course selector.
// Reuses the paid-count logic from GET /admin/training-courses (3930517) but PUBLIC + single-row.
// Returns the full course row annotated with paid_count + seats_remaining (max_students - paid_count),
// matching the admin endpoint's row+count convention. Course rows carry no PII.
// If no scheduled course exists, returns course: null so the frontend can show an empty state.
query "training-courses/upcoming" verb=GET {
  api_group = "melanite_v1"

  input {
  }

  stack {
    db.query training_courses {
      where = $db.training_courses.status == "scheduled"
      return = {type: "list"}
    } as $courses
  
    var $course {
      value = `$var.courses.0`
    }
  
    var $result {
      value = `null`
    }
  
    conditional {
      if ($course != null) {
        db.query training_enrollments {
          where = $db.training_enrollments.training_course_id == `$var.course.id` && $db.training_enrollments.deposit_paid == true
          return = {type: "list"}
        } as $paid_enrollments
      
        var $paid_count {
          value = `$var.paid_enrollments|count`
        }
      
        var $seats_remaining {
          value = `$var.course.max_students|subtract:$var.paid_count`
        }
      
        var.update $result {
          value = `$var.course`
        }
      
        var.update $result {
          value = `$var.result|set:"paid_count":$var.paid_count`
        }
      
        var.update $result {
          value = `$var.result|set:"seats_remaining":$var.seats_remaining`
        }
      }
    }
  }

  response = {course: `$var.result`}
}