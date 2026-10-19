-- Pricing in what Stripe takes, instead of Keoni absorbing it.
--
-- From 19 October the published fee schedule is what Melanite NETS. A $60 tier means $60
-- reaching Melanite, and the card is charged whatever leaves that after processing.
--
-- Two settings, because one rate cannot be right for every card: Stripe's US standard is
-- 2.9% + 30c domestic, more on Amex, more again international. They are a PREDICTION.
-- `ledger_entries.stripe_fee_cents` records what Stripe actually took, and the gap between the
-- two is what lets the rate be set from real figures rather than a guess.
--
-- stripe_fee_cents is nullable on purpose: null means nothing was processed (cash, a Groupon
-- voucher, a credited session), which is not the same fact as a fee of zero.
ALTER TABLE "platform_settings" ADD COLUMN "stripe_fee_pct" numeric(4, 3) DEFAULT '0.029' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "stripe_fee_fixed_cents" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "stripe_fee_cents" integer;
