ALTER TABLE "equipment_checks" ADD COLUMN "photo_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "equipment_checks" ADD COLUMN "photo_deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "equipment_checks" ADD COLUMN "photo_deleted_reason" text;--> statement-breakpoint
ALTER TABLE "equipment_checks" ADD CONSTRAINT "equipment_checks_photo_deleted_by_providers_id_fk" FOREIGN KEY ("photo_deleted_by") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;