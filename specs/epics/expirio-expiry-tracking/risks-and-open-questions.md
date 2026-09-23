# expirio-expiry-tracking — risks and open questions

Each entry is a letter, a title, and a state: **RISK** (open, with a
mitigation), **RESOLVED** (decided; say what and why), **ACCEPTED** (a cost we
carry knowingly), **SETTLED** (decided for now; revisit on a stated cadence).

## EX-A — a reminder that fires twice, or not at all (RISK, mitigated)

The whole product is one promise: chase me before it lapses. Both failure modes
are fatal to it — a duplicate chase trains people to ignore the mail, a missed
chase is the fine the customer bought the product to avoid. The cron is an
at-least-once trigger and a Worker invocation can be retried, so "send then
mark" can send twice and "mark then send" can lose one.

Mitigated three ways. The ladder is **materialised at write time**, so the sweep
never derives *whether* to chase, only *whether this row is still pending* —
`UNIQUE (item_id, offset_days)` makes a second row impossible rather than
unlikely. The send carries
`idempotencyKey = expiry.reminder:<reminderPublicId>`, and the notifications
context enforces `(orgId, idempotencyKey)` uniqueness, so a duplicate enqueue is
suppressed one layer down even if the row is swept twice. And a row that fails to
send stays `pending` rather than going to `failed` on the first error, so the next
hour retries it; only a row whose item has been renewed or archived is `skipped`.
The residual risk is a missed chase from a cron that does not run at all, which is
why the sweep is hourly against a date comparison rather than a single daily
run — twenty-four chances to notice a date is due, not one.

## EX-B — R2 availability for document storage (RESOLVED)

The account operator enabled R2 on 2026-09-23, and the deploy token was verified
against the account's R2 bucket API the same day before EX3 was planned. Document
upload is in scope and lands in EX3. (This entry previously carried the opposite
state; it is recorded here as resolved rather than deleted so the plan's history
stays legible.)

## EX-C — AI extraction of the document's fields (RISK, deferred)

The pitch's headline intake — photograph a licence, have the holder, issuer,
number and expiry read off it — is not in this epic. It needs a model credential
that was never handed to this build, and inventing one is not something a build
session does. What ships instead is the honest half: the document uploads and is
shown beside the item, and the four fields are typed in, which is the same amount
of typing as the spreadsheet the customer is replacing and no more.

**The unblocking step, precisely.** In the Cloudflare dashboard for the account
the deploy token belongs to, enable **Workers AI** on the account, then add an
`"ai": { "binding": "AI" }` block to `apps/expiry-worker/wrangler.template.jsonc`
for `env.stage` and `env.prod`. No new secret is needed — Workers AI is a binding,
like `send_email`. With that in place the extraction is one handler that reads the
R2 object EX3 already stores and returns a draft item for the operator to confirm;
it is a milestone (EX4), not a redesign, because EX3 deliberately stores the
document first and asks the questions second. As shipped (#11) the object is at
`expirio-documents-<env>` under `<org>/<item>/<document>`, and its row in
`expiry_documents` carries the content type and SHA-256 an extractor would need. Until then the risk is competitive,
not technical: "setup takes minutes" is carried by the vertical templates alone.

## EX-D — vertical templates as code, not data (ACCEPTED)

The three verticals are a static catalogue in `template-catalog.ts`, in the shape
of the baseline's own plan catalogue. The cost is real: an operator in a vertical
we did not anticipate — a security firm's guard licences, a fleet's DOT medical
cards — cannot author their own, and every new vertical is a deploy rather than a
row. We carry it because a catalogue in code versions with the repo, ships with
the deploy, needs no migration, no CRUD surface and no RBAC action, and because
three verticals authored by us beats an empty template table the customer has to
fill in. It becomes data the first time a customer asks for a fourth vertical we
are not willing to ship ourselves.

## EX-E — the public ingress routes are an unauthenticated surface (ACCEPTED)

`/ingress/expirio/renew` and `/ingress/expirio/calendar.ics` answer without a
session, because the entire point of the renewal link is that a technician does
not need an account. That is a real widening of the attack surface on a product
holding licence numbers.

We carry it, bounded. Tokens are opaque high-entropy bearers stored only as
SHA-256 hashes, so a database read does not yield a usable link. The renewal link
is single-use and expires in 14 days. The feed token is read-only, revocable, and
its payload carries only the item name, its kind and its date — never the
identifier, never the holder's address, never a document. The edge rate-limits
both paths as their own route family before forwarding, and it does not verify
anything, so a token never meets a component that could log it. Guessing is the
only attack left, and a 256-bit token is not guessable.

## EX-F — `expirio.app` is not in this Cloudflare account (SETTLED)

Everything answers on `*.nexo-7be.workers.dev`; bootstrap phase 07 is off
(`domain: false`). That is fine for a build and wrong for a product people are
asked to trust with compliance records — a renewal link on a `workers.dev`
subdomain reads like a phishing mail. Revisit when the zone is moved onto the
account: adopting it is one terraform component plus turning the phase on, and
the only code that changes is the absolute URL the renewal-link email renders.
