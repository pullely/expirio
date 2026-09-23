export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  /** EX3: the private R2 bucket for certificate scans and PDFs. */
  DOCUMENTS?: R2Bucket;
  ENVIRONMENT: string;
}
