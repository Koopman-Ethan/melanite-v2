CREATE TYPE "public"."provider_revenue_model" AS ENUM('split', 'house');--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "revenue_model" "provider_revenue_model" DEFAULT 'split' NOT NULL;