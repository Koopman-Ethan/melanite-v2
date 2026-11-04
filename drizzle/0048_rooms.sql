-- The suite has more than one room to rent.
--
-- Until November 2026 there was exactly one, rented by the day, and nothing in the schema named
-- it: `room_bookings` simply WAS that room. Keoni then opened two more rooms and two nail
-- stations by the month, and kept one room by the day (4 November).
--
-- `rooms` names the six spaces. The id is a readable slug, and `room_bookings.room_id` defaults
-- to 'daily' — so every booking already written, and every code path that inserts without saying
-- which room, keeps meaning the room it always meant. Names are placeholders until Keoni picks
-- them; prices are hers ($650, $650, $595, $295, $295 a month).
--
-- Written by hand: drizzle-kit's diff carried 0044-0047 again, because those were hand-written
-- too and never updated its snapshot. The snapshot this migration ships with is current.
CREATE TYPE "public"."room_kind" AS ENUM('daily', 'monthly');--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "room_kind" NOT NULL,
	"monthly_price_cents" integer,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rooms_monthly_priced" CHECK ("rooms"."kind" <> 'monthly' OR "rooms"."monthly_price_cents" > 0)
);
--> statement-breakpoint
INSERT INTO "rooms" ("id", "name", "kind", "monthly_price_cents", "sort") VALUES
	('daily',  'Daily room',      'daily',   NULL,  0),
	('room-1', 'Room 1',          'monthly', 65000, 10),
	('room-2', 'Room 2',          'monthly', 65000, 20),
	('room-3', 'Room 3',          'monthly', 59500, 30),
	('nail-1', 'Nail station 1',  'monthly', 29500, 40),
	('nail-2', 'Nail station 2',  'monthly', 29500, 50);
--> statement-breakpoint
-- The default backfills every existing row: they were all the daily room.
ALTER TABLE "room_bookings" ADD COLUMN "room_id" text DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_bookings" ADD CONSTRAINT "room_bookings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_bookings_room_id_index" ON "room_bookings" USING btree ("room_id");--> statement-breakpoint
-- Occupancy becomes per room. 0008's rule was "nothing overlaps", which with one room meant the
-- room; with six it would let one booking in Room 1 refuse a booking in Nail station 2. Same
-- rule, scoped: nothing overlaps IN THE SAME ROOM. btree_gist is already installed (0013).
ALTER TABLE "room_bookings" DROP CONSTRAINT "room_bookings_no_overlap";--> statement-breakpoint
ALTER TABLE "room_bookings"
  ADD CONSTRAINT "room_bookings_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, tstzrange("start_at", "end_at") WITH &&)
  WHERE ("status" IN ('pending', 'confirmed'));
