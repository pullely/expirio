# expiry-worker — runbook

## Health

`GET /health` (public on the worker, and behind `api-edge`'s own `/health`)
reports whether the D1 binding and the membership, policy and billing service
bindings are configured.

```bash
curl -s https://expirio-api-edge-stage.nexo-7be.workers.dev/health
```

## "A reminder did not go out"

1. Read the ladder: `GET /v1/organizations/{org}/expiry-items/{id}/reminders`.
   Every rung reports its `status` and `scheduledFor`.
2. `pending` with a past `scheduledFor` means the sweep has not reached it —
   the sweep lands in EX2; until then rows accumulate by design.
3. `skipped` means the item was renewed or archived after the rung was cut.
   That is the intended outcome, not a miss.
4. `sent` carries `recipient` and the notification id; follow that into the
   notifications context.

## "A reminder went out twice"

This should be impossible: `UNIQUE (item_id, offset_days)` prevents a second
rung, and the send is guarded by `UPDATE … WHERE status = 'pending'`, which a
racing sweep loses. If it happens, the duplicate is downstream of this worker —
check the notification's idempotency key before suspecting the ladder.

## Migrations

`200_expiry_core` creates both tables. Verify offline with
`pnpm --filter @saas/db migrate:plan`; it refuses on any checksum drift, and
`pnpm --filter @saas/db-tests test` replays the whole chain against real SQLite.

## Rolling back

The worker is stateless. Redeploy the previous version; the tables are
forward-only and nothing in this context rewrites history.
