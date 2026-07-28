-- One laser, so two appointments cannot overlap. Until now nothing said so.
--
-- The booking path used `INSERT ... SELECT ... WHERE NOT EXISTS (overlapping booking)`, and the
-- comment above it claimed that either writes the booking or writes nothing. True of the
-- statement on its own, and no defence at all against a concurrent one: under READ COMMITTED
-- both transactions evaluate NOT EXISTS against a snapshot that cannot see the other's
-- uncommitted row, both find the slot free, and both insert. Two providers, two clients, one
-- machine, same time.
--
-- room_bookings has had this constraint since 0008. The laser — the more valuable resource, and
-- the one every provider shares — had nothing.
--
-- Cancelled and no-show rows are excluded: they do not occupy the laser, and a cancelled
-- appointment must not block the slot being resold.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (tstzrange("start_time", "end_time") WITH &&)
  WHERE (status IN ('upcoming', 'completed'));
