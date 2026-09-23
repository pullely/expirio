# cloudflare-r2 — overview

One private Cloudflare R2 bucket per environment for Expirio's tracked-item
documents (EX3). Nothing is public: `expiry-worker` is the only reader and
writer, and it authorizes every read through membership + policy (or, for a
renewal-link upload, through the link's single-use token).
