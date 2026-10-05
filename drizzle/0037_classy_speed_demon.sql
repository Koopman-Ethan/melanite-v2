CREATE TABLE "blocked_time" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "blocked_time_order" CHECK ("blocked_time"."end_time" > "blocked_time"."start_time")
);
--> statement-breakpoint
ALTER TABLE "blocked_time" ADD CONSTRAINT "blocked_time_created_by_providers_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocked_time_start_time_end_time_index" ON "blocked_time" USING btree ("start_time","end_time");