DROP INDEX "prepaid_redemptions_booking_id_index";--> statement-breakpoint
CREATE UNIQUE INDEX "prepaid_redemptions_booking_id_prepaid_balance_id_index" ON "prepaid_redemptions" USING btree ("booking_id","prepaid_balance_id");--> statement-breakpoint
CREATE INDEX "prepaid_redemptions_booking_id_index" ON "prepaid_redemptions" USING btree ("booking_id");