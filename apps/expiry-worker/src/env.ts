export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
