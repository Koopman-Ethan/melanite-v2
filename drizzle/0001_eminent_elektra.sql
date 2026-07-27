CREATE TYPE "public"."payment_method" AS ENUM('stripe', 'cherry', 'groupon', 'cash', 'check', 'other');--> statement-breakpoint
CREATE TYPE "public"."payout_method" AS ENUM('stripe_connect', 'venmo', 'cash', 'check', 'other');--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "payment_method" "payment_method" DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "external_reference" text;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "payout_method" "payout_method" DEFAULT 'stripe_connect' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "payout_reference" text;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_recorded_by_providers_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_payment_method_index" ON "ledger_entries" USING btree ("payment_method");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_stripe_needs_reference" CHECK ("ledger_entries"."payment_method" <> 'stripe'
        OR "ledger_entries"."stripe_payment_intent_id" IS NOT NULL
        OR "ledger_entries"."stripe_invoice_id" IS NOT NULL);