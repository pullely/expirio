# expirio-expiry-tracking (EX) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place the
code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| EX0 — the spec | ✅ merged | #8 |
| EX1 — the tracked item and its clock | ✅ merged — but see departure 1: its audited writes 503'd on D1 until #10 | #9 |
| EX2 — templates, the ladder, the scorecard | built, PR open (task EX-3) | #10 |
| EX3 — documents, the renewal link, the feed | built, PR open (task EX-4), stacked on #10 | #11 |

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
