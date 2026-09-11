CREATE TABLE "end_of_use_checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" text NOT NULL,
	"completed_items" text[] NOT NULL,
	"item_count" integer NOT NULL,
	"device_issue" boolean NOT NULL,
	"device_issue_note" text,
	"note" text,
	CONSTRAINT "end_of_use_device_issue_note" CHECK (("end_of_use_checklists"."device_issue" and coalesce(length(btrim("end_of_use_checklists"."device_issue_note")), 0) > 0)
        or (not "end_of_use_checklists"."device_issue" and "end_of_use_checklists"."device_issue_note" is null)),
	CONSTRAINT "end_of_use_item_count" CHECK (cardinality("end_of_use_checklists"."completed_items") <= "end_of_use_checklists"."item_count")
);
--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD CONSTRAINT "end_of_use_checklists_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD CONSTRAINT "end_of_use_checklists_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "end_of_use_checklists_booking_id_index" ON "end_of_use_checklists" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "end_of_use_checklists_provider_id_recorded_at_index" ON "end_of_use_checklists" USING btree ("provider_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "end_of_use_checklists_device_issue_index" ON "end_of_use_checklists" USING btree ("device_issue") WHERE "end_of_use_checklists"."device_issue";