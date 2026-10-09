ALTER TYPE "public"."provider_revenue_model" ADD VALUE 'rental';--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "revenue_model" SET DEFAULT 'rental';