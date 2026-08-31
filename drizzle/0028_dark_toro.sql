CREATE TYPE "public"."equipment_check_kind" AS ENUM('before', 'after');--> statement-breakpoint
CREATE TABLE "equipment_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"kind" "equipment_check_kind" NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer,
	"note" text,
	"needs_attention" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "equipment_policy_ack_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "equipment_policy_ack_version" text;--> statement-breakpoint
ALTER TABLE "equipment_checks" ADD CONSTRAINT "equipment_checks_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_checks" ADD CONSTRAINT "equipment_checks_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "equipment_checks_booking_id_kind_index" ON "equipment_checks" USING btree ("booking_id","kind");--> statement-breakpoint
CREATE INDEX "equipment_checks_provider_id_recorded_at_index" ON "equipment_checks" USING btree ("provider_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "equipment_checks_needs_attention_index" ON "equipment_checks" USING btree ("needs_attention") WHERE "equipment_checks"."needs_attention";