# Epic: expirio-expiry-tracking (EX)

**Every small business carries dozens of things that quietly expire — a business
licence, a liability policy, a vehicle registration, a technician's EPA 608 card,
an SSL certificate — and today that knowledge lives in one person's calendar
until that person leaves. Expirio makes the expiry date a first-class, org-owned
resource: one row per tracked item, an escalating reminder ladder that walks
holder → manager → owner at 90/60/30/7 days, and a renewal path a staff member
can complete from a link without ever creating an account. The design idea that
makes it possible is that an expiry is not a notification setting, it is a clock
the platform owns — reminders are materialised rows with their own idempotency,
not a cron that re-derives who to email every hour.**

It is for clinics, trade contractors, childcare centres, security firms and small
multi-location operators with credential-heavy staff. When this ships they can
add a licence in under a minute from a vertical template, see a compliance
scorecard per location, get chased before a lapse instead of fined after one,
subscribe a shared calendar to every upcoming expiry, and hand a technician a
one-off upload link to renew a card without an account, a password or a seat.

## Status

| Field | Value |
|-------|-------|
| Status | In progress |
| Cluster | **EX** (EX0–EX3) |
| Owner(s) | `apps/expiry-worker` (the resource, the clock) · `apps/api-edge` (the facade and the public ingress) · `packages/db` + `packages/contracts` + `packages/sdk` (persistence and the wire) · `apps/notifications-worker` (the reminder emails) · `apps/web-console-next` (the surface) |
| Builds on | `cirrus baseline-v12` — extends identity, membership/RBAC, projects (as *locations*), events/audit, notifications, webhooks, metering and billing entitlements without forking any of them |
| Changes | Adds one bounded context (`expiry`), one worker, one R2 bucket and three public ingress routes; touches api-edge dispatch, the policy tables, the notification template map and the console nav. No existing table, route or contract changes shape. |
| Decisions locked | (1) A cirrus **project is a location** — no second tenancy axis. (2) Reminders are **materialised rows**, scheduled once at item write and swept by cron, so a resend is an idempotency violation rather than a race. (3) The public surfaces (renewal link, ICS feed) are **opaque bearer tokens stored as hashes**, verified inside `expiry-worker`, never at the edge. (4) Manual credential entry is the only intake in this epic; **AI extraction is deliberately deferred** (EX-C). |
| Gate | EX1 is invisible — the resource, its API and its SDK, with no console surface. EX2 is the first user-visible change. |
| Shipped as | |

## Read order

1. `design.md` — the resource, the routes, the surfaces, what is out of scope
2. `implementation-plan.md` — the milestones and what "done" means for each
3. `risks-and-open-questions.md` — what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md` — what actually shipped (kept distinct from intent)

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| EX0 — the spec | this doc set | merged to `main` and attached with `orun spec push` |
| EX1 — the tracked item and its clock | the `expiry` bounded context: `expiry_items` + `expiry_reminders` in D1, `apps/expiry-worker`, the org-scoped CRUD + renew routes behind `api-edge`, contracts, SDK, RBAC actions | `POST`/`GET /v1/organizations/{org}/expiry-items` answer through the edge on stage and prod, the migration is applied in both, and creating an item materialises its 90/60/30/7 reminder rows |
| EX2 — templates, the ladder, the scorecard | the vertical template catalogue (clinic, trades, childcare), the cron sweep that sends the escalating holder → manager → owner reminders through `notifications-worker`, the `expiry.*` domain events, and the console surface | applying a template creates its items in one call, the cron marks a due reminder `sent` exactly once and emits `expiry.reminder.sent`, and the console lists items and renders the per-location scorecard |
| EX3 — documents, the renewal link, the feed | an R2 bucket for certificate scans and PDFs, the no-account staff renewal link, and the signed ICS calendar feed | a document uploads and reads back, an unauthenticated holder renews an item from a single-use link, and a calendar client subscribes to `/ingress/expirio/calendar.ics` and sees every upcoming expiry |
