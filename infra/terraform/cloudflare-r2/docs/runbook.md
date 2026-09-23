# cloudflare-r2 — runbook

**Plan-only lanes fail with a missing secret.** Mint the brokered credential for
each environment (the `buckets` param is required by the template even though
the token it mints is account-wide):

```bash
orun integrations cloudflare secret create CLOUDFLARE_R2_TOKEN \
  --connection <int_…> --template r2-data \
  --param buckets=expirio-documents-<env> --env <env>
```

**Apply fails with "bucket already exists".** `adopt.tf` should import it; if the
state endpoint was unreachable at plan time, re-run the lane.
