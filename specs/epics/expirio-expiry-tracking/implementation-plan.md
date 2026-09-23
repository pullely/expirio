# expirio-expiry-tracking — implementation plan

Milestones land in order. Each is one or more tasks, each task one pull request,
each pull request landed with `orun pr land`. A milestone is marked ✅ here when
its "done when" list is true, and recorded in `IMPLEMENTATION-STATUS.md`.

## EX0 — the spec ✅

This doc set, merged to `main` and attached to the epic with `orun spec push`.

**Done when**
- the five documents are on `main`
- `orun spec list --epic expirio-expiry-tracking` shows them

## EX1 — the tracked item and its clock ✅

The `expiry` bounded context, invisible to the console. A migration adds
`expiry_items` and `expiry_reminders` and registers them in the manifest and in
`BOUNDED_CONTEXTS`. `packages/db/src/expiry` gains the repository. A new
`apps/expiry-worker` owns create, list, read, update, archive, renew and the
reminder read, each behind the membership-context → policy-authorize pair the
baseline's `create-project.ts` establishes. `packages/policy-engine` learns the
`expiry.*` actions and which roles hold them. `apps/api-edge` gains the facade,
the dispatch line, the `EXPIRY_WORKER` binding and the rate-limit family.
`packages/contracts/src/expiry.ts` and `packages/sdk/src/expiry.ts` carry the
wire. Writing an item materialises its 90/60/30/7/0 reminder ladder in the same
transaction; changing `expires_on` re-materialises the rows that have not been
sent. No cron yet — the rows exist, nothing reads them.

**Done when**
- `POST` and `GET /v1/organizations/{org}/expiry-items` answer through
  `api-edge` on both stage and prod
- migration `200_expiry_core` is applied on stage and prod, and
  `pnpm --filter @saas/db-tests test` replays it green against `node:sqlite`
- creating an item with an `expires_on` 200 days out leaves five `pending` rows
  in `expiry_reminders`, and creating it twice with the same `Idempotency-Key`
  leaves five
- `tests/expiry-worker` is green in the repo's `quick-check` lane
- an unauthorized subject gets `not_found`/404, not `forbidden`/403

## EX2 — templates, the ladder, the scorecard

The first user-visible change. `apps/expiry-worker` gains the vertical template
catalogue (clinic, trades, childcare) with a read route and an apply route that
fans one choice into a set of items in one transaction. Its `scheduled()` handler
lands: a bounded hourly sweep that sends every reminder due today through
`packages/notifications-client`, flips `pending → sent` under the
`UNIQUE (item_id, offset_days)` index, skips rows whose item has been renewed or
archived, and ages overdue items to `expired`. Three renderers join the map in
`apps/notifications-worker/src/templates/index.ts`. The `expiry.*` event types are
appended with audit, `events-worker` learns the `exi_` subject prefix, and every
one of them reaches customers as a signed webhook with no further work. The
scorecard route aggregates per location in SQL. The console lands the register,
the item page, the new-item form with the template picker, the scorecard, and the
nav entry.

**Done when**
- `GET /v1/organizations/{org}/expiry-templates` returns the three verticals, and
  `POST …/expiry-templates/clinic/apply` creates its items in one call
- a reminder row whose `scheduled_for` is today is `sent` exactly once across two
  consecutive cron invocations, and carries a `notification_id`
- a renewed item's unsent reminder rows are `skipped`, and the new date's ladder
  is `pending`
- `expiry.reminder.sent` and `expiry.item.renewed` appear in
  `GET /v1/organizations/{org}/audit`
- `orgs/[orgSlug]/expiry` and `…/expiry/scorecard` render against stage, and the
  console build and `tests/web-console-next` are green

## EX3 — documents, the renewal link, the feed

The open edges. A new `infra/terraform/cloudflare-r2` component provisions one
bucket per environment and publishes its name through the wiring seam;
`expiry-worker` binds it and gains proxied upload, list and content routes, with
the tenant in the object key and a 10 MB, image-or-PDF ceiling. `expiry_documents`,
`expiry_renewal_links` and `expiry_feed_tokens` land in migration `210_expiry_edges`.
Three exact public paths are allow-listed at the edge ahead of the authenticated
facades and forwarded unverified; `expiry-worker` hashes the presented token and
looks it up. The renewal link is single-use and 14-day; submitting it sets the new
expiry date, optionally attaches a photo, re-materialises the ladder and appends
`expiry.item.renewed` with a `link` actor. The ICS feed renders `text/calendar`
with one `VEVENT` per upcoming expiry and leaks no identifier or holder address.
The console gains the documents panel, the "send a renewal link" action and the
feed-token settings page.

**Done when**
- migration `210_expiry_edges` is applied on stage and prod
- a PDF uploaded to an item reads back byte-identical through
  `GET /v1/organizations/{org}/expiry-documents/{id}/content`, and a request for
  another org's document id answers `not_found`
- `GET /ingress/expirio/renew?token=…` answers 200 with no `Authorization`
  header, and answers `not_found` after the link is consumed
- `GET /ingress/expirio/calendar.ics?token=…` answers `text/calendar` that a
  calendar client subscribes to, and answers `not_found` for a revoked token
- the README status is `✅ Shipped` and **Shipped as** names the four PRs

## Sequencing note

EX1 is the spine: EX2's cron has nothing to sweep and EX3's renewal link has
nothing to renew until `expiry_items` and `expiry_reminders` exist and the ladder
is materialised, so it goes first and goes alone. EX2 and EX3 touch disjoint
files after that — EX2 is the cron, the templates, the email map and the console;
EX3 is terraform, the public ingress and a second migration — but they are landed
in order anyway, because EX3's renewal submit re-materialises the ladder EX2's
sweep reads, and reviewing that interaction against merged code is cheaper than
reviewing it against two open branches. Nothing here is gated on a provider we do
not have: R2 was verified against this account's bucket API before EX3 was
planned, and the one capability that *is* gated on a missing credential — AI
extraction — was cut out of the epic rather than sequenced into it (EX-C).
