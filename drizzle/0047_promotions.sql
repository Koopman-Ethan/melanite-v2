-- Keoni can run a promotion without a developer, and without locking anybody out.
--
-- From 20 October she can take a flat amount or a percentage off one service, or off
-- everything, for a date range. The fee schedule is the wrong tool for that: a published
-- schedule is immutable and ACCEPTED — `providers.rental_schedule_version` records which
-- version each provider agreed to, and publishing a new one blocks every provider from booking
-- until they accept it. A week of 25% off run through the pricing editor would lock everybody
-- out twice, once when it started and once when it ended.
--
-- A promotion only ever REDUCES what a provider pays, so there is nothing for them to agree to:
-- they already accepted a higher ceiling. That is what lets this sit on top of the schedule as
-- a separate layer instead of becoming a version of it, and it is why neither `kind` can
-- express an increase.
--
-- DATES, BOTH INCLUSIVE, Denver. "to 31 Oct" covers sessions on the 31st. Rent is charged about
-- twelve hours after a session ends, so the fee is resolved against the SESSION's date rather
-- than against now() — otherwise every promotion's last day would be charged at full price the
-- following morning.
--
-- `value` is a percentage for 'percent' and cents for 'amount'. Reusing `discount_type` rather
-- than inventing a parallel vocabulary; 'none' is meaningless here and is refused.
CREATE TABLE "rental_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"tier_key" text,
	"kind" "discount_type" NOT NULL,
	"value" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	CONSTRAINT "rental_promotions_kind" CHECK ("rental_promotions"."kind" <> 'none'),
	CONSTRAINT "rental_promotions_named" CHECK (length(trim("rental_promotions"."name")) > 0),
	CONSTRAINT "rental_promotions_percent_range" CHECK ("rental_promotions"."kind" <> 'percent' OR ("rental_promotions"."value" >= 1 AND "rental_promotions"."value" <= 99)),
	CONSTRAINT "rental_promotions_amount_positive" CHECK ("rental_promotions"."kind" <> 'amount' OR "rental_promotions"."value" > 0),
	CONSTRAINT "rental_promotions_dates_ordered" CHECK ("rental_promotions"."ends_on" >= "rental_promotions"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "rental_promotions" ADD CONSTRAINT "rental_promotions_created_by_providers_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_promotions" ADD CONSTRAINT "rental_promotions_ended_by_providers_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rental_promotions_ends_on_index" ON "rental_promotions" USING btree ("ends_on");
