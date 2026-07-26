# FIX — booking refunds never reach the `transactions` ledger

> **STATUS: NOT BEING APPLIED TO v1. Decided by Ethan 2026-07-26.**
>
> **Reasoning corrected 2026-07-26 after reading Stripe directly. Reason 1 below was wrong.**
>
> 1. ~~It would be dead code — `charge.refunded` is not subscribed in live per BUG-21.~~
>    **FALSE.** `charge.refunded` **is** subscribed and live on the platform endpoint
>    (`we_1Tqd2hCP9MreAgWjntXeufCG`, `livemode: true`) and on the room endpoint. The branch
>    runs in production today. Booking refunds arrive, match no training enrollment, and are
>    silently dropped — active data loss, not dead code.
> 2. **It is forward-only.** Still true. It does nothing for refunds already issued, which
>    must be reconstructed from Stripe regardless.
>
> **The decision still stands, but on different grounds: total exposure is $17.25.** Stripe
> holds exactly two refunds ever — one room rental ($60.00, handled correctly by the room
> webhook) and one booking (`re_3TqmnZCP9MreAgWj0CpDPuFi`, $17.25, 2026-07-06). That single
> booking refund is the entire overstatement in `transactions`. It is one row to correct at
> import, which does not justify editing a live money path.
>
> **Revisit if refund volume rises before cutover.** The defect is live; only the volume is
> small.
>
> **The condition this decision depends on:** the v2 ETL must source refunds from **Stripe**,
> not from v1's `transactions` table. If it trusts the v1 ledger, v2 silently inherits the
> overstatement forever. See `docs/v1-spec/api-review.md` §D2.
>
> This document is kept as the specification of the defect and the correct handling — the
> ledger semantics, the cumulative-`amount_refunded` delta logic, and the open
> `reverse_transfer` question all carry over to the v2 implementation directly.

**Target:** Xano endpoint `POST /webhooks/stripe/platform` (API #3910318, group `melanite_v1`)
**Paste type:** **INSERT** a new block — additive, nothing existing is edited or removed
**Insertion point:** inside the `charge.refunded` branch, **after line 899, before line 900**
(i.e. immediately after the closing `}` of the existing training-enrollment `conditional`,
at the same 8-space indent). Written against the version read 2026-07-26 — re-check the line
numbers before pasting if the endpoint has changed since.

---

## What's wrong

The `charge.refunded` branch (line 734) resolves the payment intent against
`training_enrollments` **only**. The single `db.add transactions` in the whole 904-line
endpoint is at line 462, inside `payment_intent.succeeded`.

So a refunded laser booking leaves `transactions` untouched — `gross_amount`, `melanite_cut`
and `provider_payout` stay as if the money was kept. `/admin/revenue`,
`/admin/dashboard-summary` and `/earnings` overstate permanently, and because the ledger is
append-only nothing ever reconciles it.

`/webhooks/stripe/package` and `/webhooks/stripe/room` both already do this correctly. This
just applies the same pattern to the ledger carrying the most money.

## Two differences from the package pattern, forced by the `transactions` schema

`transactions` has **no `type` column** and **no `note` column** (unlike
`package_transactions`). So:

1. **A refund is recorded as a NEGATIVE-amount row**, not a `type="refund"` row. This is the
   key design choice and it is deliberate: every existing consumer (`/admin/revenue`,
   `/earnings`, `/provider/dashboard-summary`) already just SUMs these columns, so negative
   rows **net out automatically with zero changes to any reporting endpoint.** No live
   endpoint gets touched.
2. **The charge id isn't recorded**, since there's nowhere to put it. It stays available in
   `webhook_log.raw_payload`.

## `amount_refunded` is cumulative — this writes the delta

Stripe sends `charge.refunded` on every refund with `amount_refunded` as the **running total**,
not the increment. The existing package path guards on "does any refund row exist" (`count == 0`),
which means **a second partial refund is silently ignored** — see follow-up below.

This block instead sums what's already been booked against the PI and writes only the
difference. Repeated partial refunds each land exactly once, and webhook retries are no-ops
because the delta comes out as zero.

---

## The block to insert

```
      
        // ── BOOKING REFUNDS — added 2026-07-26 ────────────────────────────────────
        // Was missing entirely: the branch above resolves training enrollments only, so a
        // refunded laser booking left `transactions` untouched and every revenue figure
        // stayed overstated forever.
        //
        // Recorded as a NEGATIVE row rather than type="refund" — transactions has no `type`
        // column, and every consumer already SUMs, so refunds net out with no reporting change.
        //
        // amount_refunded is CUMULATIVE, so we book only the delta against what we've already
        // recorded: repeated partial refunds each land once, and retries are no-ops.
        db.query transactions {
          where = $db.transactions.stripe_payment_intent_id == `$var.rf_pi` && $db.transactions.gross_amount > 0
          return = {type: "list"}
        } as $bkrf_matches
      
        conditional {
          if (($bkrf_matches|count) > 0) {
            var $bkrf_txn {
              value = `$var.bkrf_matches|first`
            }
          
            db.query transactions {
              where = $db.transactions.stripe_payment_intent_id == `$var.rf_pi` && $db.transactions.gross_amount < 0
              return = {type: "list"}
            } as $bkrf_prior_rows
          
            // Refunded so far, on the same base Stripe measures against (price + tip).
            // Prior rows are negative, so subtracting accumulates a positive total.
            var $bkrf_prior {
              value = `0`
            }
          
            foreach ($bkrf_prior_rows) {
              each as $bkrf_pr {
                var.update $bkrf_prior {
                  value = `$var.bkrf_prior|subtract:$bkrf_pr.gross_amount|subtract:$bkrf_pr.tip_amount`
                }
              }
            }
          
            var $bkrf_target {
              value = `$input.data.object.amount_refunded|divide:100`
            }
          
            var $bkrf_delta {
              value = `$var.bkrf_target|subtract:$var.bkrf_prior`
            }
          
            conditional {
              if ($bkrf_delta > 0) {
                // Scale the original split by the newly-refunded fraction of (gross + tip).
                // cut + payout == gross + tip holds in the source row, so it holds here too.
                var $bkrf_base {
                  value = `$var.bkrf_txn.gross_amount|add:$var.bkrf_txn.tip_amount`
                }
              
                var $bkrf_ratio {
                  value = `1`
                }
              
                conditional {
                  if ($bkrf_base > 0) {
                    var.update $bkrf_ratio {
                      value = `$var.bkrf_delta|divide:$var.bkrf_base`
                    }
                  }
                }
              
                conditional {
                  if ($bkrf_ratio > 1) {
                    var.update $bkrf_ratio {
                      value = `1`
                    }
                  }
                }
              
                var $bkrf_g_abs {
                  value = `$var.bkrf_txn.gross_amount|multiply:$var.bkrf_ratio|round:2`
                }
              
                var $bkrf_t_abs {
                  value = `$var.bkrf_txn.tip_amount|multiply:$var.bkrf_ratio|round:2`
                }
              
                var $bkrf_p_abs {
                  value = `$var.bkrf_txn.provider_payout|multiply:$var.bkrf_ratio|round:2`
                }
              
                var $bkrf_c_abs {
                  value = `$var.bkrf_txn.melanite_cut|multiply:$var.bkrf_ratio|round:2`
                }
              
                var $bkrf_gross {
                  value = `0|subtract:$var.bkrf_g_abs`
                }
              
                var $bkrf_tip {
                  value = `0|subtract:$var.bkrf_t_abs`
                }
              
                var $bkrf_payout {
                  value = `0|subtract:$var.bkrf_p_abs`
                }
              
                var $bkrf_cut {
                  value = `0|subtract:$var.bkrf_c_abs`
                }
              
                // payout_status "paid" keeps this row OUT of the pending-payout sums in
                // /earnings and /provider/dashboard-summary. Clawback is manual — same
                // policy as the package refund SOP. See "Decision" below.
                db.add transactions {
                  enforce_hidden_fields = false
                  data = {
                    provider_id             : `$var.bkrf_txn.provider_id`
                    booking_id              : `$var.bkrf_txn.booking_id`
                    checkout_link_id        : `$var.bkrf_txn.checkout_link_id`
                    source                  : "booking"
                    gross_amount            : `$var.bkrf_gross`
                    tip_amount              : `$var.bkrf_tip`
                    provider_payout         : `$var.bkrf_payout`
                    melanite_cut            : `$var.bkrf_cut`
                    stripe_payment_intent_id: `$var.rf_pi`
                    payout_status           : "paid"
                  }
                } as $bkrf_row
              }
            }
          }
        }
```

Note: `webhook_log.processed` is already set to `true` unconditionally at the top of the
`charge.refunded` branch (line 735), so this block deliberately does **not** set it again.

---

## `payout_status: "paid"` — settled, do not change to "pending"

Checked 2026-07-26 against `/pay/{token}/pay` and `/webhooks/stripe/connect`.

`payout_status` does **not** mean "have we paid the provider." `/pay/{token}/pay` creates a
**destination charge** (`transfer_data[destination]`), so the provider's share reaches their
connected account at charge time. `payout_status` tracks the separate Stripe payout from that
connected account to their bank — `payout.paid` flips *all* of a provider's pending rows to
`paid` with the payout's `arrival_date`; `payout.failed` flips them to `failed`.

So `"pending"` on a refund row would be wrong twice: it would reduce `pending_payout` in
`/earnings` and `/provider/dashboard-summary` for money that already left the platform, and
the next `payout.paid` sweep would stamp it with an unrelated payout's arrival date.

`"paid"` with **no `payout_date`** keeps the row inert and out of every sum. That's what the
block does.

## ANSWERED — refunds do NOT reverse the provider transfer

Verified 2026-07-26 against live Stripe. **The proportional split in the block above is
wrong.** Corrected logic is below; the block is left as-written for the record.

The one booking refund on record:

```
refund   re_3TqmnZCP9MreAgWj0CpDPuFi   $17.25   transfer_reversal: null
charge   pi_3TqmnZCP9MreAgWj0bO5sHqx   type=booking_payment
                                        transfer_data.destination = acct_1TqmHnCSuVTKKSSR
                                        application_fee_amount    = $7.50
```

It was a genuine destination charge to a provider's connected account, and
`transfer_reversal` is **null** — the transfer was not reversed. The provider kept their
$9.75; the platform refunded the full $17.25 from its own balance and absorbed the loss.

*(The other refund, `re_3Tta9o…` $60.00, was a room rental — `transfer_data: null`, a plain
platform charge — so it says nothing about the booking path. Worth noting it independently
confirms the v2 model for room rentals: 100% platform, no split.)*

**Correct entry for a booking refund, as refunds are actually issued today:**

| column | value |
|---|---|
| `gross_amount` | −(refunded portion of price) |
| `tip_amount` | −(refunded portion of tip) |
| `provider_payout` | **0** — unchanged, the provider keeps their share |
| `melanite_cut` | **−(full refund delta)** — the platform absorbs all of it |

Note this breaks the `cut + payout == gross + tip` invariant that holds for purchases, and it
should: the platform is out more than its cut. Any v2 check constraint must allow it.

**This also means the existing package refund path is wrong the same way** — it splits
proportionally. No bad data yet, since packages aren't live, but fix it before
`packages_enabled` goes true.

## Known cosmetic side-effect

`/admin/revenue` and `/earnings` increment a per-provider / per-service `count` by 1 per row,
so a refund adds 1 to the *transaction count* instead of subtracting. **Money is correct;
counts inflate.** Fixing it means editing two live reporting endpoints, which is a bigger blast
radius than the money fix deserves — deliberately left as a separate change.

---

## Test plan

Signature verification will reject a hand-rolled call, so test through Stripe.

1. **Baseline:** MCP-read `/admin/revenue` → record `lifetime_revenue`, and MCP-read the
   `transactions` row for the PI you're about to refund.
2. **Partial refund** (say 50%) in the Stripe dashboard. Confirm:
   - exactly one new `transactions` row, all four money columns negative
   - `melanite_cut + provider_payout == gross_amount + tip_amount` on the new row
   - `lifetime_revenue` dropped by the refunded cut
3. **Refund the remaining 50%.** Confirm a *second* negative row for the delta only, and that
   the sum across all three rows for that PI is exactly zero on every money column.
4. **Retry idempotency:** resend the last `charge.refunded` from the Stripe dashboard. Confirm
   **no new row** (delta computes to zero).
5. **Regression:** refund a *training* deposit and confirm the existing enrollment path still
   updates `amount_paid` / `balance_due` / `payment_status`, and that no `transactions` row is
   written (no matching PI).
6. Log the test rows under a **CLN** entry.

## Follow-up spotted while writing this

`/webhooks/stripe/package` (line ~343) guards its refund on
`type == "refund"` → `count == 0`, so **a second partial refund on a package is silently
dropped.** Same class of bug as this one, smaller blast radius. The delta approach above is
the fix; worth a FUP.
