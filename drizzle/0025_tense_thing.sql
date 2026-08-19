CREATE TYPE "public"."prepaid_status" AS ENUM('active', 'exhausted');--> statement-breakpoint
ALTER TYPE "public"."booking_payment_source" ADD VALUE 'prepaid' BEFORE 'comped';--> statement-breakpoint
ALTER TYPE "public"."ledger_source" ADD VALUE 'prepaid';--> statement-breakpoint
ALTER TYPE "public"."ledger_subject_type" ADD VALUE 'prepaid_balance';--> statement-breakpoint
CREATE TABLE "prepaid_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"original_amount" numeric(10, 2) NOT NULL,
	"remaining_amount" numeric(10, 2) NOT NULL,
	"purchased_at" timestamp with time zone,
	"status" "prepaid_status" DEFAULT 'active' NOT NULL,
	"purchaser_name" text,
	"purchaser_email" text,
	CONSTRAINT "prepaid_balances_remaining_in_range" CHECK ("prepaid_balances"."remaining_amount" >= 0 AND "prepaid_balances"."remaining_amount" <= "prepaid_balances"."original_amount")
);
--> statement-breakpoint
CREATE TABLE "prepaid_checkout_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"purchaser_name" text,
	"purchaser_email" text,
	"status" "checkout_link_status" DEFAULT 'pending' NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_intent_id" text,
	"prepaid_balance_id" uuid,
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prepaid_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prepaid_balance_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"amount_applied" numeric(10, 2) NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	CONSTRAINT "prepaid_redemptions_amount_positive" CHECK ("prepaid_redemptions"."amount_applied" > 0)
);
--> statement-breakpoint
ALTER TABLE "prepaid_balances" ADD CONSTRAINT "prepaid_balances_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_balances" ADD CONSTRAINT "prepaid_balances_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_checkout_links" ADD CONSTRAINT "prepaid_checkout_links_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_checkout_links" ADD CONSTRAINT "prepaid_checkout_links_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_checkout_links" ADD CONSTRAINT "prepaid_checkout_links_prepaid_balance_id_prepaid_balances_id_fk" FOREIGN KEY ("prepaid_balance_id") REFERENCES "public"."prepaid_balances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_redemptions" ADD CONSTRAINT "prepaid_redemptions_prepaid_balance_id_prepaid_balances_id_fk" FOREIGN KEY ("prepaid_balance_id") REFERENCES "public"."prepaid_balances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_redemptions" ADD CONSTRAINT "prepaid_redemptions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prepaid_balances_client_id_status_index" ON "prepaid_balances" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "prepaid_balances_provider_id_status_index" ON "prepaid_balances" USING btree ("provider_id","status");--> statement-breakpoint
CREATE INDEX "prepaid_balances_client_id_purchased_at_index" ON "prepaid_balances" USING btree ("client_id","purchased_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prepaid_checkout_links_token_index" ON "prepaid_checkout_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "prepaid_checkout_links_provider_id_status_index" ON "prepaid_checkout_links" USING btree ("provider_id","status");--> statement-breakpoint
CREATE INDEX "prepaid_checkout_links_stripe_payment_intent_id_index" ON "prepaid_checkout_links" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "prepaid_redemptions_prepaid_balance_id_index" ON "prepaid_redemptions" USING btree ("prepaid_balance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prepaid_redemptions_booking_id_index" ON "prepaid_redemptions" USING btree ("booking_id");