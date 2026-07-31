CREATE TYPE "public"."practice_type" AS ENUM('laser', 'room_only');--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "practice_type" "practice_type" DEFAULT 'laser' NOT NULL;