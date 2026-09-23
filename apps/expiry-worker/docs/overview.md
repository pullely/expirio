# expiry-worker — overview

Owns the `expiry` bounded context: the **tracked item** (a licence, permit,
insurance policy, registration or certification that has a date on it) and the
**reminder ladder** materialised against that date.

The product's whole promise is one sentence — chase me before it lapses — so the
invariant this worker exists to hold is that a due reminder is sent exactly
once. It is held in the schema rather than in code: the ladder is written when
the item is written, and `UNIQUE (item_id, offset_days)` makes a second rung at
the same distance impossible.

## What it serves

| Route | Action |
|---|---|
| `POST /v1/organizations/{org}/expiry-items` | `expiry.item.create` |
| `GET /v1/organizations/{org}/expiry-items` | `expiry.item.read` |
| `GET /v1/organizations/{org}/expiry-items/{id}` | `expiry.item.read` |
| `PATCH /v1/organizations/{org}/expiry-items/{id}` | `expiry.item.update` |
| `DELETE /v1/organizations/{org}/expiry-items/{id}` | `expiry.item.delete` (archive) |
| `POST /v1/organizations/{org}/expiry-items/{id}/renew` | `expiry.item.renew` |
| `GET /v1/organizations/{org}/expiry-items/{id}/reminders` | `expiry.item.read` |

It is unreachable from the internet: every request arrives over the
`EXPIRY_WORKER` service binding from `api-edge`, which has already resolved the
actor into `x-actor-subject-id` / `x-actor-subject-type`.

## What it reuses

`membership-worker` for the authorization context, `policy-worker` for the
decision, `billing-worker` for the `limit.expiry_items` ceiling, and
`events-worker`'s tables (through `@saas/db/events`) for the audit trail. A
cirrus **project is a location** — no second tenancy axis was invented.
