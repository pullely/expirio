# expirio-expiry-tracking (EX) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place the
code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| EX0 — the spec | ✅ merged | #8 |
| EX1 — the tracked item and its clock | ✅ merged — but see departure 1: its audited writes 503'd on D1 until #10; and fix 2: its routes answered 404 until EX-6 | #9, EX-6 |
| EX2 — templates, the ladder, the scorecard | ✅ merged — but see fix 1: the owner rungs reached nobody on D1 until task EX-5; and fix 2 | #10, #13 (EX-5) |
| EX3 — documents, the renewal link, the feed | ✅ merged — but see fix 2 | #12 (EX-4; #11 was its stacked first PR) |

## Departures from the design

1. **Baseline departure — the cirrus D1 fix (#10).** `cirrus baseline-v12`'s
   `appendEventWithAudit` and the membership repository's organization-create
   and invitation-accept writes are Postgres data-modifying CTEs that SQLite
   cannot parse, so on D1 every audited write failed and no organization could
   be created. EX1's item routes check that result, so from #9 until #10 they
   answered 503 after writing the item. #10 applies the portfolio's portable
   fix (D1-compatible multi-statement writes, first landed in chaseid) with a
   real-SQLite schema test in `tests/db`, and touches the `component.yaml` of
   every worker that bundles it so the plan redeploys them.
2. **`rowCount` on D1 counts returned rows (#10).** The D1 executor reports
   `rows.length`, so a write without `RETURNING` always reports 0. EX1's
   repository inspected the count of seven such writes; each now says
   `RETURNING id`. Without it the sweep would have treated every send as a lost
   race and never appended `expiry.reminder.sent`.
3. **Template apply is `expiry.item.create` (#10),** not the separate
   `expiry.template.apply` action §2 names. Applying a template is creating
   items, and folding it in leaves the policy package — and policy-worker —
   untouched.
4. **The owner tier is read by a join (#10).** The sweep reads the org's owner
   addresses with a read-only join onto `membership_role_assignments`,
   `membership_organization_members` and `identity_users` in the same D1
   database, rather than over the membership service binding. Nothing is
   written across the context boundary.
5. **Escalation falls upward (#10).** A holder rung with no holder email goes to
   the manager, then the owner; a manager rung with no manager goes to the
   owner; a rung with nobody at all is marked `failed`. §4 did not say.
6. **Not yet wired:** the `expiry.reminders_sent` usage metric (§4 Metering).
7. **EX3 authorization reuses the EX1 actions (#11).** Document upload is
   `expiry.item.update`, document read `expiry.item.read`, minting a renewal
   link `expiry.item.renew`, and managing calendar feeds `expiry.item.delete`
   (the admin/owner action) — not the `expiry.document.*`, `expiry.link.create`
   and `expiry.feed.manage` actions §2 names. Same reason as departure 3: the
   policy package and policy-worker stay untouched.
8. **Feeds can be revoked through the API (#11):** `DELETE
   /v1/organizations/{org}/expiry-feeds/{id}`, which §2 did not list but "revocable"
   requires. Three event types join `EXPIRY_EVENT_TYPES`:
   `expiry.renewal_link.created`, `expiry.feed.created`, `expiry.feed.revoked`.
9. **The R2 bucket is bound by name (#11),** `expirio-documents-<env>`, not
   through a `@@wiring(cloudflare-r2/…)@@` token — an R2 binding resolves by
   name, and a deterministic name removes the worker's deploy-time dependency on
   the wiring secret. The component still lease-publishes `WIRING_CLOUDFLARE_R2`.
   Its terraform runs under a brokered `CLOUDFLARE_R2_TOKEN` (`r2-data`
   template), minted for stage and prod before the PR.
10. **The holder's renewal page is `/renew` on the console (#11),** a public
    page outside the signed-in shell that calls the two `/ingress/expirio/renew`
    paths with a client carrying no session token. A document upload is
    `POST …/documents` with the file as the body and the name in `?filename=`
    (or `x-filename`), rather than multipart.
11. **The feed looks back seven days,** so an item that lapsed this week is
    still on the calendar, and carries at most 500 entries.

## Fixes after ship

1. **The owner rung reached nobody (task EX-5).** `listOwnerEmails` joined
   `identity_users u ON u.id = ra.subject_id`, but on D1 the membership tables
   store the subject as the PUBLIC id (`usr_<32 hex>`) while `identity_users.id`
   is the UUID, so the join matched nothing and the sweep marked every owner
   rung (the 7-day and the day-of) `failed` for want of a recipient. A manager
   or holder rung with nobody on file fell upward into the same hole. The join
   now matches `u.id` against the subject id AND its UUID form (the leakbook
   LB-6 fix, copied as is), so a UUID-shaped subject still resolves. The
   real-SQLite test in `tests/db/src/sqlite-schema.test.ts` now seeds the
   membership rows both ways; the `usr_` case fails on the old join. The first
   version seeded UUIDs on both sides, which is how the bug hid.
   `apps/expiry-worker/component.yaml` is touched so the live worker picks up
   the new `packages/db`.
2. **Every expiry route answered 404 on stage and prod (task EX-6).** EX1 (#9)
   added the `expiry.item.*` actions to `packages/policy-engine`, but no PR
   touched `apps/policy-worker/component.yaml` — neither EX1 nor the redeploy
   lists of #10, #12 and #13 — and the deploy plan keys off each worker's own
   `component.yaml` (runbook trap 17). So the live `policy-worker` on stage and
   prod stayed on its 2026-09-23 04:52Z deploy with the baseline permission
   table: its bundles contained `expiry.item.create` zero times, while the
   expiry-worker bundles contained it four times. Every `expiry.*` check was
   denied, and `authz.allowed()` turns a deny into `not_found`, so every item,
   template, document, link and feed route answered 404 to everyone, owner
   included. Stage D1 held zero `expiry_items` ever. **EX1–EX3 were marked
   shipped while this was true;** the README's ✅ was recorded from green deploy
   lanes and `/health`, not from a signed-in request to an expiry route. EX-6
   touches `apps/policy-worker/component.yaml` so the plan redeploys it from
   `main`. It ships nothing else: `packages/policy-engine`'s last change is
   EX1's, and the only other package policy-worker imports, `packages/contracts`,
   changed only in modules it does not import (`expiry`, `notifications`).
