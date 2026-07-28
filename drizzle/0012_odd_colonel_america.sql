ALTER TABLE "training_courses" ADD COLUMN "seats_taken" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD COLUMN "seat_held_until" timestamp with time zone;--> statement-breakpoint
-- Backfill: every seat already claimed by a paid enrolment. Without this the counter starts at
-- zero on a course that is already full and the next enrolment oversells it immediately.
UPDATE "training_courses" c
   SET "seats_taken" = (
     SELECT count(*) FROM "training_enrollments" e
      WHERE e."training_course_id" = c."id" AND e."payment_status" <> 'unpaid'
   );
--> statement-breakpoint
-- The counter must never exceed capacity or go negative. A CHECK rather than trust: this is
-- the constraint the old application-level count could not provide.
ALTER TABLE "training_courses"
  ADD CONSTRAINT "training_courses_seats_within_capacity"
  CHECK ("seats_taken" >= 0 AND "seats_taken" <= "max_students");
