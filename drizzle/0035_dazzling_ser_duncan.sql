ALTER TABLE "providers" ADD COLUMN "rental_terms_ack_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "rental_terms_version" text;