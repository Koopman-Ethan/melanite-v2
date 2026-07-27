ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'no_show_fee';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'late_cancellation_fee';--> statement-breakpoint
DROP INDEX "ledger_entries_stripe_payment_intent_id_index";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "default_payment_method_id" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "card_brand" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "card_last4" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "card_exp_month" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "card_exp_year" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "card_on_file_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "card_on_file_consent_version" text;--> statement-breakpoint
ALTER TABLE "package_checkout_links" ADD COLUMN "client_phone" text;--> statement-breakpoint
ALTER TABLE "package_checkout_links" ADD COLUMN "price" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_checkout_links" ADD COLUMN "client_package_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "late_cancellation_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "fee_provider_share_pct" numeric(4, 3) DEFAULT '0.500' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "card_policy_version" text DEFAULT '2026-07-27.v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "cherry_apply_url" text;--> statement-breakpoint
ALTER TABLE "package_checkout_links" ADD CONSTRAINT "package_checkout_links_client_package_id_client_packages_id_fk" FOREIGN KEY ("client_package_id") REFERENCES "public"."client_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_stripe_payment_intent_id_index" ON "ledger_entries" USING btree ("stripe_payment_intent_id") WHERE "ledger_entries"."stripe_payment_intent_id" IS NOT NULL AND "ledger_entries"."entry_type" <> 'refund';