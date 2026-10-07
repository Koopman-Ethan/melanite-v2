ALTER TABLE "bookings" ADD COLUMN "outcome_reason" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rental_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rental_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rental_reviewed_by_providers_id_fk" FOREIGN KEY ("rental_reviewed_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;