# FIX — booking refunds never reach the `transactions` ledger

> **STATUS: NOT BEING APPLIED TO v1. Decided by Ethan 2026-07-26.**
>
> Corrected in v2 instead, at import. Two reasons:
>
> 1. **It would be dead code today.** Per BUG-21, `charge.refunded` is not subscribed in
>    Stripe live, so this branch never fires in production. Applying the fix would require
>    BUG-21 as well — two changes to a live money path.
> 2. **It is forward-only.** It does nothing for refunds already issued. If `charge.refunded`
>    has never been subscribed in live, that is *every* refund to date. Those must be
>    reconstructed from Stripe regardless, so the fix would not remove a reconciliation step
>    from the ETL — only shorten the window.
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

## Open question — does the refund reverse the provider transfer?

This one is a real decision and it changes the numbers.

With destination charges, whether the provider's share returns on a refund depends on
`reverse_transfer`, set when the refund is issued:

- **`reverse_transfer = true`** — the provider's share is pulled from their connected balance.
  The proportional split in this block (negative `provider_payout` *and* negative
  `melanite_cut`) is correct as written.
- **`reverse_transfer` off** — the provider keeps their share and the platform absorbs the
  entire refund. The correct entry would be `melanite_cut` = −(full refund) with
  `provider_payout` unchanged at 0.

This block assumes the first. The package refund path assumes the same split, but its note
says *"provider clawback handled manually per the refund SOP"* — which implies transfers are
**not** auto-reversed. If that's the case, both paths record an intent to claw back rather
than a settled fact, and `/earnings` shows providers a reduced lifetime payout for money they
still hold.

**Confirm how refunds are actually issued in the Stripe dashboard before publishing.** If
transfers are not reversed, swap the four `_abs` computations for: `melanite_cut` = the full
`$bkrf_delta`, `provider_payout` = 0, and keep `gross_amount` / `tip_amount` as they are.

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
