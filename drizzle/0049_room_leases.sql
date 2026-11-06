-- Monthly leases for the rooms and nail stations (Keoni, 4 November 2026).
--
-- Six-month contracts, separate from the laser and set up by Keoni: nobody applies. Rent is a
-- Stripe subscription on the tenant's saved card, prorated for a part-month and then taken on the
-- 1st, with Stripe's fee passed to the tenant. A deposit is refunded after a completed term with
-- 30 days' notice and kept if the tenant leaves early; `held_outside` covers the two nail-station
-- tenants who were renting before the app knew about them.
--
-- `invite_links.practice_type` is how a tenant is invited AS a tenant, so they never see the
-- laser choice. Null on older invites, which still ask.
--
-- The rooms take Keoni's names. Suite C is the $595 one — her two $650 rooms were listed first.
CREATE TYPE "public"."room_deposit_status" AS ENUM('held_outside', 'charged', 'refunded', 'kept');--> statement-breakpoint
CREATE TYPE "public"."room_lease_status" AS ENUM('pending', 'active', 'past_due', 'ended');--> statement-breakpoint
ALTER TYPE "public"."ledger_source" ADD VALUE 'room_lease';--> statement-breakpoint
ALTER TYPE "public"."ledger_subject_type" ADD VALUE 'room_lease';--> statement-breakpoint
CREATE TABLE "room_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"provider_id" uuid NOT NULL,
	"room_id" text NOT NULL,
	"status" "room_lease_status" DEFAULT 'pending' NOT NULL,
	"starts_on" date NOT NULL,
	"term_months" integer DEFAULT 6 NOT NULL,
	"monthly_cents" integer NOT NULL,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"deposit_status" "room_deposit_status" NOT NULL,
	"deposit_payment_intent_id" text,
	"deposit_decided_at" timestamp with time zone,
	"notice_given_on" date,
	"ends_on" date,
	"ended_at" timestamp with time zone,
	"past_due_since" timestamp with time zone,
	"stripe_subscription_id" text,
	CONSTRAINT "room_leases_rent_positive" CHECK ("room_leases"."monthly_cents" > 0),
	CONSTRAINT "room_leases_deposit_nonnegative" CHECK ("room_leases"."deposit_cents" >= 0),
	CONSTRAINT "room_leases_term_positive" CHECK ("room_leases"."term_months" > 0)
);
--> statement-breakpoint
ALTER TABLE "invite_links" ADD COLUMN "practice_type" "practice_type";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "stripe_product_id" text;--> statement-breakpoint
ALTER TABLE "room_leases" ADD CONSTRAINT "room_leases_created_by_providers_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_leases" ADD CONSTRAINT "room_leases_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_leases" ADD CONSTRAINT "room_leases_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_leases_provider_id_index" ON "room_leases" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "room_leases_room_id_index" ON "room_leases" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_leases_stripe_subscription_id_index" ON "room_leases" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_leases_one_live_per_room" ON "room_leases" USING btree ("room_id") WHERE "room_leases"."status" <> 'ended';
--> statement-breakpoint
UPDATE "rooms" SET "name" = CASE "id"
	WHEN 'daily'  THEN 'Daily Room Rental'
	WHEN 'room-1' THEN 'Suite A'
	WHEN 'room-2' THEN 'Suite B'
	WHEN 'room-3' THEN 'Suite C'
	WHEN 'nail-1' THEN 'Nail Station 1'
	WHEN 'nail-2' THEN 'Nail Station 2'
	ELSE "name" END;
