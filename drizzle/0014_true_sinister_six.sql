ALTER TYPE "public"."membership_plan" ADD VALUE 'epicutis';--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "epicutis_price_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_provider_plan_unique" ON "memberships" USING btree ("provider_id","plan");