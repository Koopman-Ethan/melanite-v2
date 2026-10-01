ALTER TYPE "public"."booking_payment_source" ADD VALUE 'rental';--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "client_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rental_has_no_client" CHECK ("bookings"."payment_source" <> 'rental' OR ("bookings"."client_id" IS NULL AND "bookings"."client_name" IS NULL
        AND "bookings"."client_phone" IS NULL AND "bookings"."client_email" IS NULL));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rental_has_no_price" CHECK ("bookings"."payment_source" <> 'rental' OR ("bookings"."price" = 0 AND "bookings"."original_price" = 0
        AND "bookings"."discount_type" = 'none'));