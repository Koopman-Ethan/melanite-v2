CREATE TYPE "public"."discount_type" AS ENUM('none', 'percent', 'amount');--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "discount_type" "discount_type" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "discount_value" numeric(10, 2) DEFAULT '0' NOT NULL;