CREATE TABLE "rental_fee_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_version" integer NOT NULL,
	"tier_key" text NOT NULL,
	"single_cents" integer NOT NULL,
	"suggested_low_cents" integer NOT NULL,
	"suggested_high_cents" integer NOT NULL,
	CONSTRAINT "rental_fee_entries_single_positive" CHECK ("rental_fee_entries"."single_cents" > 0),
	CONSTRAINT "rental_fee_entries_below_suggested" CHECK ("rental_fee_entries"."single_cents" < "rental_fee_entries"."suggested_low_cents"),
	CONSTRAINT "rental_fee_entries_range_order" CHECK ("rental_fee_entries"."suggested_high_cents" >= "rental_fee_entries"."suggested_low_cents")
);
--> statement-breakpoint
CREATE TABLE "rental_fee_schedules" (
	"version" integer PRIMARY KEY NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "rental_schedule_version" integer;--> statement-breakpoint
ALTER TABLE "rental_fee_entries" ADD CONSTRAINT "rental_fee_entries_schedule_version_rental_fee_schedules_version_fk" FOREIGN KEY ("schedule_version") REFERENCES "public"."rental_fee_schedules"("version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_fee_schedules" ADD CONSTRAINT "rental_fee_schedules_published_by_providers_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rental_fee_entries_schedule_version_tier_key_index" ON "rental_fee_entries" USING btree ("schedule_version","tier_key");