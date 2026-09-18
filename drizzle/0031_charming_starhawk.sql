ALTER TABLE "equipment_checks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "equipment_checks" CASCADE;--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD COLUMN "photo_storage_key" text;--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD COLUMN "photo_mime_type" text;--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD COLUMN "photo_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD COLUMN "photo_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD COLUMN "photo_deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD COLUMN "photo_deleted_reason" text;--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD CONSTRAINT "end_of_use_checklists_photo_deleted_by_providers_id_fk" FOREIGN KEY ("photo_deleted_by") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN "equipment_policy_ack_at";--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN "equipment_policy_ack_version";--> statement-breakpoint
ALTER TABLE "end_of_use_checklists" ADD CONSTRAINT "end_of_use_issue_photo" CHECK (not "end_of_use_checklists"."device_issue" or "end_of_use_checklists"."photo_storage_key" is not null);--> statement-breakpoint
DROP TYPE "public"."equipment_check_kind";