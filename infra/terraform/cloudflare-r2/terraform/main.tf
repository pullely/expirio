terraform {
  required_version = ">= 1.15.0"

  # State lives on the platform (SB1): the runner exports TF_HTTP_* per job, so
  # this block stays empty — no S3 bucket, no AWS role, no workspaces.
  backend "http" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

# --- Providers ---

# Authenticates via the CLOUDFLARE_API_TOKEN env var (provider-native): the
# token is an orun-managed secret resolved into the job env at run time, so it
# never transits Terraform variables.
provider "cloudflare" {}

# --- Variables (standard Orun parameters) ---

variable "cloudflare_account_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare account ID (from CLOUDFLARE_ACCOUNT_ID env var)"
}

variable "orgName" {
  type    = string
  default = "sourceplane"
}

variable "owner" {
  type    = string
  default = "sourceplane"
}

variable "repo" {
  type    = string
  default = "expirio"
}

variable "namespace" {
  type    = string
  default = "sourceplane"
}

variable "namespacePrefix" {
  type    = string
  default = ""
}

variable "lane" {
  type    = string
  default = "verify"
}

variable "environment" {
  type    = string
  default = "stage"
}

variable "component" {
  type    = string
  default = "cloudflare-r2"
}

variable "stackName" {
  type    = string
  default = "cloudflare-r2"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- R2 bucket for tracked-item documents (EX3) ---
#
# One private bucket per environment, holding the certificate scans and PDFs
# attached to expiry items. Objects are keyed <org_uuid>/<item_uuid>/<doc_uuid>
# — the tenant is in the key — and are never overwritten. Nothing is public:
# every read goes through expiry-worker, authorized by membership + policy.
#
# The name is deterministic — expiry-worker's wrangler template binds it by
# name — so it deliberately does not take var.namespacePrefix: a prefix
# supplied at run time would silently diverge from the binding.
locals {
  documents_bucket_name = "expirio-documents-${var.environment}"
}

resource "cloudflare_r2_bucket" "documents" {
  account_id = var.cloudflare_account_id
  name       = local.documents_bucket_name
}

# --- Wiring manifest (BF5, via orun secrets) ---
# An R2 binding resolves by bucket NAME, not by an opaque id; the document is
# published for parity with D1 and KV so any later consumer can read it back.

output "wiring" {
  description = "Wiring document for downstream deploy-time binding resolution (pushed to orun secrets)"
  value = jsonencode({
    expiry_documents_bucket_name = cloudflare_r2_bucket.documents.name
  })
}

output "expiry_documents_bucket_name" {
  description = "Cloudflare R2 bucket holding tracked-item documents"
  value       = cloudflare_r2_bucket.documents.name
}
