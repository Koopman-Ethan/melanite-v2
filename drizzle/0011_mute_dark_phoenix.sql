ALTER TABLE "bookings" ADD COLUMN "fee_charge_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "fee_charge_error" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "fee_waived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "fee_waived_by" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_fee_waived_by_providers_id_fk" FOREIGN KEY ("fee_waived_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;