ALTER TYPE "public"."room_booking_status" ADD VALUE 'pending' BEFORE 'confirmed';--> statement-breakpoint
DROP INDEX "room_bookings_rental_date_slot_type_index";--> statement-breakpoint
ALTER TABLE "room_bookings" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "room_full_day_price" numeric(10, 2) DEFAULT '100.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "room_half_day_price" numeric(10, 2) DEFAULT '60.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "room_am_start" text DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "room_am_end" text DEFAULT '13:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "room_pm_end" text DEFAULT '18:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "room_advance_days" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_bookings" ADD COLUMN "stripe_payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "room_bookings" ADD COLUMN "stripe_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "room_bookings" ADD COLUMN "hold_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "room_bookings_status_index" ON "room_bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "room_bookings_stripe_payment_intent_id_index" ON "room_bookings" USING btree ("stripe_payment_intent_id");;--> statement-breakpoint
-- Occupancy for a physical room is an overlap rule, not a (date, slot_type) uniqueness rule.
-- The unique index this replaces stopped two 'am' bookings on the same day but allowed 'full'
-- to be sold on a day that already had one — the room would have been double-let.
--
-- 'pending' rows are included so a hold taken during checkout genuinely blocks the slot.
-- v1 had no equivalent: it created no row until the webhook fired, so its availability check
-- was a read with nothing behind it and two providers could both pay for the same day.
ALTER TABLE "room_bookings"
  ADD CONSTRAINT "room_bookings_no_overlap"
  EXCLUDE USING gist (tstzrange("start_at", "end_at") WITH &&)
  WHERE ("status" IN ('pending', 'confirmed'));
