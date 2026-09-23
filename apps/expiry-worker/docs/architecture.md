# expiry-worker — architecture

## The two tables

`expiry_items` is the thing that expires. `expiry_reminders` is the ladder
scheduled against it: one row per rung, `offset_days` ∈ {90, 60, 30, 7, 0},
`tier` walking `holder → holder → manager → owner → owner`.

## Why the ladder is materialised

A cron that derived "who should be chased today" from the items table would have
to be right about deduplication in code, every hour, forever. Writing the rungs
at item-write time moves that question into the database: the sweep only ever
asks *is this row still `pending`?*, and the unique index makes a duplicate rung
unrepresentable. It also makes the ladder inspectable — `GET …/reminders` shows
an operator exactly what will happen and when, before it happens.

Rungs whose date has already passed are **not** scheduled. Back-dating a chase
would fire it on the next sweep and tell a holder their licence expired eighty
days ago in a mail headed "90 days to go"; an item added inside its own warning
window simply starts at the rung it is actually in.

## Moving the date

`PATCH` with a new `expiresOn` deletes the **pending** rungs and re-cuts them
against the new date. `POST …/renew` marks them `skipped` instead, then writes
the new ladder — skipped-before-written, so a rung both ladders would occupy is
the new one and not a stale `pending` row the sweep would have sent. Rungs
already `sent` are never touched in either path: a chase that went out is a
fact, not a plan.

## Transactions

D1 has no interactive transaction (`@saas/db`'s `executor.transaction` runs
statements in order with no rollback), so the order of writes is the design:
the item first, its ladder second, the event and audit entry last. A failure
part-way leaves a real, reviewable state rather than a phantom one.

## Failure posture

Authorization failure answers `not_found`/404, never `forbidden` — a non-member
cannot probe whether an item exists. The billing gate is the one deliberate
exception to failing closed: an organization whose plan declares no expiry
entitlement is **allowed**, because refusing to record a licence over a missing
billing row is the wrong trade for a product whose job is not losing track of
one.
