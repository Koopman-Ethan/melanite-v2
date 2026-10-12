ALTER TABLE "bookings" ADD COLUMN "rent_charge_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rent_charge_error" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rent_charge_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rent_waived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rent_waived_by" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rent_waived_by_providers_id_fk" FOREIGN KEY ("rent_waived_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;