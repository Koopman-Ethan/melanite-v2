ALTER TABLE "bookings" ADD COLUMN "fee_override_cents" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "fee_set_by" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "fee_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_fee_set_by_providers_id_fk" FOREIGN KEY ("fee_set_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;