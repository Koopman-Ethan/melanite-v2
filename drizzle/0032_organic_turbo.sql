ALTER TYPE "public"."ledger_source" ADD VALUE 'rental_fee';--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "billing_payment_method_id" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "billing_card_brand" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "billing_card_last4" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "billing_card_exp_month" integer;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "billing_card_exp_year" integer;