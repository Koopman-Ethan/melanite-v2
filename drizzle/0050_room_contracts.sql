-- Signed room contracts, as files (Keoni via Ethan, 11 November 2026).
--
-- The tenant uploads theirs on the Room Rental page, or Keoni uploads it for them. A contract
-- belongs to the tenant until a lease is started or renewed with it, which is when `lease_id` is
-- set. A lease cannot start without one and ends when its term does, until a new one is uploaded.
CREATE TABLE "room_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by" uuid,
	"provider_id" uuid NOT NULL,
	"lease_id" uuid,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_contracts" ADD CONSTRAINT "room_contracts_uploaded_by_providers_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_contracts" ADD CONSTRAINT "room_contracts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_contracts" ADD CONSTRAINT "room_contracts_lease_id_room_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."room_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_contracts_provider_id_index" ON "room_contracts" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "room_contracts_lease_id_index" ON "room_contracts" USING btree ("lease_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_contracts_storage_key_index" ON "room_contracts" USING btree ("storage_key");