# cloudflare-r2 — architecture

- `cloudflare_r2_bucket.documents`, named `expirio-documents-<environment>`.
- The name is deterministic because the worker binds it by name; no prefix is
  applied at run time.
- `adopt.tf` imports a bucket that exists in Cloudflare but not in the platform
  state, so a lost state write does not wedge the next apply.
- The terraform runs under `CLOUDFLARE_R2_TOKEN`, a brokered credential minted
  from the `r2-data` scope template, never the Workers deploy token.
- Object keys are `<org_uuid>/<item_uuid>/<document_uuid>` — the tenant is in
  the key.
