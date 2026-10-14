CREATE TYPE "public"."provider_rent_basis" AS ENUM('tier', 'half_own_price');--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "rent_basis" "provider_rent_basis" DEFAULT 'tier' NOT NULL;