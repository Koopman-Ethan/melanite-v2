-- What a `keoni_sets` provider says they charged their client, and the receipt backing it.
--
-- Melanite derives no fee for those three, so Keoni needs an input before she can set one. The
-- AMOUNT is the input; the file is evidence she only opens when the number looks wrong.
--
-- `receipt_deleted_at` exists because a receipt is very likely to carry a client's name, and
-- the rental terms promise that Melanite keeps no record of who a provider's clients are. The
-- file is removed once the session is charged or waived; the amount and the timestamp stay, so
-- "was there a receipt, and what did it say" is still answerable without holding a document
-- about somebody who never agreed to it.
ALTER TABLE "bookings" ADD COLUMN "receipt_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "receipt_storage_key" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "receipt_mime_type" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "receipt_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "receipt_deleted_at" timestamp with time zone;
