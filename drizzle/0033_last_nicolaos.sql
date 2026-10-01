ALTER TYPE "public"."ledger_subject_type" ADD VALUE 'provider_pack';--> statement-breakpoint
CREATE TABLE "provider_pack_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_pack_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"session_index" integer NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"tier_key" text NOT NULL,
	"sessions_total" integer NOT NULL,
	"sessions_used" integer DEFAULT 0 NOT NULL,
	"amount_paid" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"purchased_at" timestamp with time zone,
	"stripe_payment_intent_id" text,
	"note" text,
	CONSTRAINT "provider_packs_sessions_total" CHECK ("provider_packs"."sessions_total" > 0),
	CONSTRAINT "provider_packs_sessions_used" CHECK ("provider_packs"."sessions_used" >= 0 AND "provider_packs"."sessions_used" <= "provider_packs"."sessions_total"),
	CONSTRAINT "provider_packs_amount_paid" CHECK ("provider_packs"."amount_paid" >= 0),
	CONSTRAINT "provider_packs_comped_needs_note" CHECK ("provider_packs"."amount_paid" > 0 OR coalesce(length(btrim("provider_packs"."note")), 0) > 0)
);
--> statement-breakpoint
ALTER TABLE "provider_pack_redemptions" ADD CONSTRAINT "provider_pack_redemptions_provider_pack_id_provider_packs_id_fk" FOREIGN KEY ("provider_pack_id") REFERENCES "public"."provider_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_pack_redemptions" ADD CONSTRAINT "provider_pack_redemptions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_packs" ADD CONSTRAINT "provider_packs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_pack_redemptions_provider_pack_id_index" ON "provider_pack_redemptions" USING btree ("provider_pack_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_pack_redemptions_booking_id_index" ON "provider_pack_redemptions" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "provider_packs_provider_id_tier_key_index" ON "provider_packs" USING btree ("provider_id","tier_key");