# expirio-expiry-tracking — design

## 1. The resource

One new bounded context, `expiry`, owned end to end by `apps/expiry-worker`. It
follows the baseline's rules without exception: every table carries `org_id`,
location-scoped tables also carry `project_id`, there are no foreign keys across
contexts, ids are stored as bare UUIDs and rendered on the wire as
`<prefix>_<32 hex>` through `packages/db/src/ids`.

**Reused from the baseline, unchanged.** `membership_organizations` is the
tenant. `projects_projects` **is the location** — a clinic's two sites, a
contractor's three depots — so the scorecard, the ICS feed and the reminder
ladder all scope by `project_id` and no second tenancy axis is invented.
`identity_users` and `membership_organization_members` supply the owner tier of
the escalation. `events_event_log` / `events_audit_entries` take every mutation.
`notifications_notifications` carries every reminder email. `billing_entitlements`
gates the item count per plan (`limit.expiry_items`).

```
expiry_items                            exi_…
  id             text      uuid, primary key
  org_id         text      owning organization (uuid) — every query scopes by it
  project_id     text      owning location (uuid), nullable = org-wide
  name           text      "State pharmacy licence", "EPA 608 Type II"
  kind           text      license|permit|insurance|certification|registration|domain|ssl|other
  template_key   text      nullable — the vertical template row this came from
  issuer         text      nullable — "Texas Medical Board"
  identifier     text      nullable — the licence/policy number, entered by hand
  holder_name    text      nullable
  holder_email   text      nullable — tier 1 of the ladder
  manager_email  text      nullable — tier 2 of the ladder
  status         text      active|expiring|expired|renewed|archived
  issued_on      text      nullable, ISO date
  expires_on     text      ISO date — the clock
  notes          text      nullable
  created_by     text      actor subject id
  created_at     text      ISO-8601
  updated_at     text      ISO-8601
  archived_at    text      nullable

expiry_reminders                        exr_…
  id             text      uuid, primary key
  org_id         text
  item_id        text      the expiry_items row (uuid, same context — FK allowed)
  offset_days    integer   90 | 60 | 30 | 7 | 0
  tier           text      holder|manager|owner
  scheduled_for  text      ISO date = expires_on - offset_days
  status         text      pending|sent|skipped|failed
  recipient      text      nullable, resolved at send
  notification_id text     nullable, the notifications_notifications id
  sent_at        text      nullable
  UNIQUE (item_id, offset_days)         -- the idempotency of the ladder

expiry_documents                        exd_…            (EX3)
  id, org_id, item_id, r2_key (text, unique), filename, content_type,
  size_bytes (integer), uploaded_by (nullable — a link upload has no actor),
  uploaded_at

expiry_renewal_links                    exl_…            (EX3)
  id, org_id, item_id, token_hash (text, unique), created_by, expires_at,
  consumed_at (nullable), created_at

expiry_feed_tokens                      exf_…            (EX3)
  id, org_id, project_id (nullable), label, token_hash (unique), created_by,
  revoked_at (nullable), last_used_at (nullable), created_at
```

The ladder is **materialised, not derived**. When an item is created or its
`expires_on` changes, `expiry-worker` writes exactly the reminder rows that are
still in the future — four tiers by default (90 → holder, 60 → holder, 30 →
manager, 7 → owner) plus a `0` owner row on the expiry day itself. Rows already
`sent` are never rewritten. The `UNIQUE (item_id, offset_days)` index is what
makes "did we already chase this?" a database fact rather than a cron's memory.

Vertical templates are a **static catalogue in code**, not a table —
`apps/expiry-worker/src/template-catalog.ts`, in the shape of the baseline's own
`apps/billing-worker/src/plan-catalog.ts`. `clinic` (DEA registration, CPR/BLS
card, state professional licence, malpractice policy), `trades` (EPA 608, OSHA
10, contractor licence, general liability, vehicle registration), `childcare`
(state childcare licence, CPR/first aid, background check, fire inspection). A
template row carries `name`, `kind`, `issuer` hint and a default validity in
months; applying one creates the items and lets the operator fill in the real
dates. A catalogue in code ships with the deploy, versions with the repo and
costs no migration — the cost is that an operator cannot author their own
vertical, which is recorded as EX-D.

## 2. The API

All authenticated routes sit behind `apps/api-edge`, which matches the path,
resolves the actor, applies the route-family rate limit and the idempotency
replay, then forwards over the `EXPIRY_WORKER` service binding. Envelopes are the
baseline's: `{ data, meta: { requestId, cursor } }` on success,
`{ error: { code, message, details, requestId } }` on failure, with the
deny-by-default convention that an authorization failure answers `not_found`/404
rather than 403.

```
POST   /v1/organizations/{org}/expiry-items                      expiry.item.create
GET    /v1/organizations/{org}/expiry-items                      expiry.item.read
GET    /v1/organizations/{org}/expiry-items/{id}                 expiry.item.read
PATCH  /v1/organizations/{org}/expiry-items/{id}                 expiry.item.update
DELETE /v1/organizations/{org}/expiry-items/{id}                 expiry.item.delete   (archive)
POST   /v1/organizations/{org}/expiry-items/{id}/renew           expiry.item.renew
GET    /v1/organizations/{org}/expiry-items/{id}/reminders       expiry.item.read
GET    /v1/organizations/{org}/expiry-templates                  expiry.item.read
POST   /v1/organizations/{org}/expiry-templates/{key}/apply      expiry.template.apply
GET    /v1/organizations/{org}/expiry-scorecard                  expiry.item.read
POST   /v1/organizations/{org}/expiry-items/{id}/documents       expiry.document.write  (EX3)
GET    /v1/organizations/{org}/expiry-items/{id}/documents       expiry.document.read   (EX3)
GET    /v1/organizations/{org}/expiry-documents/{id}/content     expiry.document.read   (EX3)
POST   /v1/organizations/{org}/expiry-items/{id}/renewal-links   expiry.link.create     (EX3)
POST   /v1/organizations/{org}/expiry-feeds                      expiry.feed.manage     (EX3)
GET    /v1/organizations/{org}/expiry-feeds                      expiry.feed.manage     (EX3)
```

`GET …/expiry-items` filters on `projectId`, `kind`, `status`, `expiresBefore`,
`expiresAfter`, `q`, and paginates with the baseline's opaque
`encodeCursor(createdAt, id)`. `GET …/expiry-scorecard` returns, per location,
the counts by status and the number of items expiring inside 30 days — computed
in SQL, never in the console.

`POST …/renew` takes `{ expiresOn, identifier?, notes? }`, moves `status` back to
`active`, re-materialises the ladder for the new date, and appends
`expiry.item.renewed`.

**Public ingress (EX3).** Three exact paths, allow-listed in
`apps/api-edge/src/index.ts` *before* the authenticated facades, following the
pattern `apps/api-edge/src/integrations-facade.ts` already sets for
`/ingress/github/setup`: the edge rate-limits and forwards, it does not verify.
The token is an opaque `exl_…`/`exf_…` bearer whose SHA-256 hash is the stored
column; `expiry-worker` hashes what it receives and looks the row up, so the edge
never holds a verifier.

```
GET    /ingress/expirio/renew?token=…          the holder's renewal form payload
POST   /ingress/expirio/renew                  submit a new expiry date (+ optional document)
GET    /ingress/expirio/calendar.ics?token=…   text/calendar, the location's upcoming expiries
```

The renewal link is single-use (`consumed_at`) and short-lived (14 days). The
feed token is long-lived and revocable, read-only, and returns only
`name`/`kind`/`expires_on` — never the licence number, never the holder's email.

## 3. The console

`apps/web-console-next`, App Router, URL-driven scope, every call through the
SDK and `useApiQuery`, exactly as `orgs/[orgSlug]/projects/page.tsx` does today.

- `orgs/[orgSlug]/expiry` — the register. A table of tracked items with the days
  remaining rendered as the primary column, filters for location, kind and
  status, and a "renew" action that opens the date form. Added to the primary
  sidebar through `src/components/shell/nav-items.ts`.
- `orgs/[orgSlug]/expiry/new` — manual entry, and the vertical-template picker
  that fans one choice out into a set of draft items.
- `orgs/[orgSlug]/expiry/[itemId]` — one item: its dates, its ladder with each
  reminder's state, its documents (EX3), and the button that mints a staff
  renewal link (EX3).
- `orgs/[orgSlug]/expiry/scorecard` — compliance per location, the audit-ready
  view: counts by status, what lapses inside 30 days, and a CSV download built
  from the same payload.
- `orgs/[orgSlug]/settings/expiry` — the calendar feed tokens: mint, label,
  revoke (EX3).

Query keys go in `src/lib/query-keys.ts` (`qk.expiryItems(orgId, filters)`,
`qk.expiryItem(orgId, id)`, `qk.expiryScorecard(orgId)`). Forms use `ZodForm`.

## 4. Events, secrets, and integrations

**Domain events**, appended inside the handler's transaction with
`appendEventWithAudit`, category `expiry`, and declared as `EXPIRY_EVENT_TYPES`
in `packages/contracts/src/expiry.ts` so subscribers have something to read:
`expiry.item.created`, `expiry.item.updated`, `expiry.item.renewed`,
`expiry.item.archived`, `expiry.item.expiring`, `expiry.item.expired`,
`expiry.reminder.sent`, `expiry.document.attached`. They reach customers as
signed outbound webhooks with no extra work — `webhooks-worker`'s cron fans out
whatever lands in `events_event_log`, so a subscription on `expiry.*` is all a
customer needs. `apps/events-worker/src/ids.ts` gains `expiry_item → exi_` in
`SUBJECT_KIND_PREFIX` so the audit view renders public ids.

**Email.** Three renderers added to the one map in
`apps/notifications-worker/src/templates/index.ts`: `expiry.reminder.holder`,
`expiry.reminder.manager`, `expiry.reminder.owner`. The manager and owner
templates name the holder and how many days are left; the holder template
carries the renewal link when one exists. Sending goes through
`packages/notifications-client`'s `enqueueNotification` from the cron, post-commit
and best-effort, with `idempotencyKey = expiry.reminder:<reminderPublicId>`. No
licence number is ever placed in `templateData`.

**The clock.** `apps/expiry-worker/wrangler.template.jsonc` declares
`"triggers": { "crons": ["25 * * * *"] }` at the top level and the worker exports
a `scheduled()` handler beside its `fetch()`, in the shape of
`apps/metering-worker/src/index.ts`. The sweep is bounded: it selects reminders
with `status = 'pending' AND scheduled_for <= today`, capped per org, oldest
first; it re-checks the item is still `active` (a renewed item's stale rows are
marked `skipped`); it flips `status` to `sent` and records the notification id.
A second sweep pass ages `active` items whose `expires_on` has passed into
`expired` and appends `expiry.item.expired`.

**Storage (EX3).** One R2 bucket per environment, declared in a new
`infra/terraform/cloudflare-r2` component that publishes
`WIRING_CLOUDFLARE_R2=wiring` and is consumed as
`@@wiring(cloudflare-r2/stage:expiry_documents_bucket_name)@@` in
`apps/expiry-worker/wrangler.template.jsonc`, with a fixture value in
`wiring.fixture.json` so the offline dry-run renders. Objects are keyed
`<org_uuid>/<item_uuid>/<document_uuid>` — the tenant is in the key, so a
cross-tenant read is a bug that cannot be reached by guessing an id. Uploads are
proxied through the worker rather than presigned: the worker is where the
authorization and the 10 MB / `image/*`+`application/pdf` limits live, and a
presigned URL would put an S3 credential in a browser. R2 is enabled on this
Cloudflare account and the deploy token was verified against the bucket API on
2026-09-23 (EX-B).

**Billing.** A `limit.expiry_items` entitlement checked in
`create-expiry-item.ts` exactly as `create-project.ts` checks `limit.projects` —
50 on the $19 plan, 500 on the $49 plan, unbounded on multi-location. A refusal
is `precondition_failed`/412, which the console already renders as an upsell
through `PreconditionInsight`.

**Metering.** Each sent reminder records a usage row on metric
`expiry.reminders_sent`, which is what "lapses prevented" will eventually be
measured against.

## 5. Out of scope

- **AI extraction of holder, issuer, number and expiry from an uploaded scan.**
  The document is stored and shown; the fields are typed in. Deferred for want of
  a model credential — EX-C, with the exact unblocking step.
- **Slack and Teams alerts.** They fall out of the existing signed outbound
  webhooks for anyone who wants them today; a first-party integration needs its
  own OAuth app and belongs in the integrations context, not here.
- **SMS.** No provider credential, and the baseline's notifications context only
  speaks email.
- **Inbound email intake** ("forward your renewal notice to a mailbox"). Needs
  Cloudflare Email Routing on a domain this account does not hold.
- **Operator-authored vertical templates.** The catalogue is code in this epic;
  making it data is EX-D.
- **A public marketing site and self-serve signup.** The baseline's console and
  magic-link identity are the product surface for this release.
- **The custom domain `expirio.app`.** The zone is not in this Cloudflare
  account, so phase 07 is off and everything answers on `nexo-7be.workers.dev`.
