ALTER TABLE "package_checkout_links" ADD COLUMN "cherry_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_links" DROP COLUMN "cherry_started_at";