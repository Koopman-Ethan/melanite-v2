ALTER TABLE "services" ADD COLUMN "category" text;--> statement-breakpoint

-- Group the catalogue that already exists.
UPDATE "services" SET "category" = 'Laser hair removal' WHERE "name" LIKE 'Laser Hair Removal%';--> statement-breakpoint
UPDATE "services" SET "category" = 'Tattoo removal' WHERE "name" LIKE 'Tattoo Removal%';--> statement-breakpoint
UPDATE "services" SET "category" = 'Skin treatments' WHERE "category" IS NULL;--> statement-breakpoint

-- Laser hair removal by body area, replacing XSmall / Small / Medium / Large.
--
-- The sizes asked a client to classify their own body against a bracket, and asked the provider
-- to agree — "is a Brazilian medium?" has no answer a booking page can settle. Named areas are
-- what both people already say out loud.
--
-- Durations are Keoni's, 2026-07-31, given as a pair: what it typically takes, and the longest a
-- provider should book for it. Those map onto `suggested_duration_mins` and `max_duration_mins`
-- respectively — defaulting to her ceiling would block 90 minutes of laser for every back and
-- cost Melanite most of a treatment slot a day.
--
-- Three areas were not in her reply: bikini, half arms and full arms. Their values come from the
-- brackets the old sizes put them in (half arm sat with half leg, which she timed at 30/60) and
-- are MARKED BELOW, so they can be corrected without re-deriving which ones were guessed.
-- Providers set their own duration per service regardless; these are the defaults offered and
-- the bounds allowed.
--
-- Listed head to toe here for readability. On screen they sort alphabetically within their
-- group, which is what somebody hunting for "Brazilian" in a list of twelve actually scans by.
INSERT INTO "services"
  ("name", "description", "category", "suggested_duration_mins", "min_duration_mins",
   "max_duration_mins", "package_eligible", "advanced_tier_required", "color_hex", "active")
VALUES
  ('Laser Hair Removal — Upper Lip',  NULL, 'Laser hair removal', 15, 15, 30, true, false, '#B8965A', true),
  ('Laser Hair Removal — Full Face',  NULL, 'Laser hair removal', 15, 15, 30, true, false, '#B8965A', true),
  ('Laser Hair Removal — Underarms',  NULL, 'Laser hair removal', 15, 15, 30, true, false, '#B8965A', true),
  -- proposed, NOT from Keoni: half arm sat in the same bracket as half leg
  ('Laser Hair Removal — Half Arms',  NULL, 'Laser hair removal', 30, 15, 60, true, false, '#B8965A', true),
  -- proposed, NOT from Keoni
  ('Laser Hair Removal — Full Arms',  NULL, 'Laser hair removal', 45, 30, 60, true, false, '#B8965A', true),
  ('Laser Hair Removal — Chest',      NULL, 'Laser hair removal', 60, 45, 90, true, false, '#B8965A', true),
  ('Laser Hair Removal — Abs',        NULL, 'Laser hair removal', 60, 45, 90, true, false, '#B8965A', true),
  ('Laser Hair Removal — Back',       NULL, 'Laser hair removal', 60, 45, 90, true, false, '#B8965A', true),
  -- proposed, NOT from Keoni: smaller than a Brazilian, timed the same to be safe
  ('Laser Hair Removal — Bikini',     NULL, 'Laser hair removal', 30, 15, 60, true, false, '#B8965A', true),
  ('Laser Hair Removal — Brazilian',  NULL, 'Laser hair removal', 30, 15, 60, true, false, '#B8965A', true),
  ('Laser Hair Removal — Half Legs',  NULL, 'Laser hair removal', 30, 15, 60, true, false, '#B8965A', true),
  ('Laser Hair Removal — Full Legs',  NULL, 'Laser hair removal', 60, 45, 90, true, false, '#B8965A', true);--> statement-breakpoint

-- Retire the sizes rather than delete them.
--
-- `provider_services.service_id` is ON DELETE RESTRICT and appointments reference the provider
-- service, so deleting these would either fail outright or destroy the record of what a past
-- client was actually treated for. Deactivating removes them from every place a NEW appointment
-- can be created — `getAvailableServices` and the booking form both filter on `services.active`
-- — while history keeps naming them correctly.
--
-- A provider who already offers one keeps their `provider_services` row. The My Services page
-- reads `services.active` as `offeredPlatformWide`, which is the signal to go and add the areas
-- they actually perform.
UPDATE "services" SET "active" = false
 WHERE "name" IN ('Laser Hair Removal (XSmall)', 'Laser Hair Removal (Small)',
                  'Laser Hair Removal (Medium)', 'Laser Hair Removal (Large)');
