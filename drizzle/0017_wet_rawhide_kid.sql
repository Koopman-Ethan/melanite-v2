ALTER TYPE "public"."booking_payment_source" ADD VALUE 'external';--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "external_method" "payment_method";--> statement-breakpoint
-- A route and a method are different questions, and only one combination of answers is
-- coherent: 'external' must say which, and nothing else may.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_external_method_matches_source"
  CHECK (
    (payment_source = 'external' AND external_method IS NOT NULL)
    OR (payment_source <> 'external' AND external_method IS NULL)
  );
