import type {
  ApplyExpiryTemplateRequest,
  ApplyExpiryTemplateResponse,
  GetExpiryScorecardResponse,
  ListExpiryTemplatesResponse,
  ArchiveExpiryItemResponse,
  CreateExpiryItemRequest,
  CreateExpiryItemResponse,
  GetExpiryItemResponse,
  ListExpiryItemsResponse,
  ListExpiryRemindersResponse,
  RenewExpiryItemRequest,
  RenewExpiryItemResponse,
  UpdateExpiryItemRequest,
  UpdateExpiryItemResponse,
} from "@saas/contracts/expiry";

import type { Transport, RequestOptions } from "./transport.js";

export interface ListExpiryItemsQuery {
  projectId?: string | "none";
  kind?: string;
  status?: string;
  expiresBefore?: string;
  expiresAfter?: string;
  limit?: number;
  cursor?: string;
}

function queryString(query: ListExpiryItemsQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

/**
 * Expiry resource client — the tracked items and their reminder ladder.
 *
 * Org-scoped: every method takes `orgId` first. Maps to `apps/expiry-worker`
 * through the api-edge `expiry-facade` route.
 */
export class ExpiryClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/expiry-items */
  list(
    orgId: string,
    query: ListExpiryItemsQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListExpiryItemsResponse> {
    return this.transport.request<ListExpiryItemsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items${queryString(query)}`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/expiry-items/:itemId */
  get(orgId: string, itemId: string, opts: RequestOptions = {}): Promise<GetExpiryItemResponse> {
    return this.transport.request<GetExpiryItemResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items/${encodeURIComponent(itemId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/expiry-items
   *
   * Creating an item also materialises its 90/60/30/7/0 reminder ladder. Pass
   * `idempotencyKey` in `opts` for safe retry semantics.
   */
  create(
    orgId: string,
    body: CreateExpiryItemRequest,
    opts: RequestOptions = {},
  ): Promise<CreateExpiryItemResponse> {
    return this.transport.request<CreateExpiryItemResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items`,
        body,
      },
      opts,
    );
  }

  /**
   * PATCH /v1/organizations/:orgId/expiry-items/:itemId
   *
   * Moving `expiresOn` re-cuts the unsent rungs of the ladder against the new
   * date; rungs already sent are left alone.
   */
  update(
    orgId: string,
    itemId: string,
    body: UpdateExpiryItemRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateExpiryItemResponse> {
    return this.transport.request<UpdateExpiryItemResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items/${encodeURIComponent(itemId)}`,
        body,
      },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/expiry-items/:itemId/renew */
  renew(
    orgId: string,
    itemId: string,
    body: RenewExpiryItemRequest,
    opts: RequestOptions = {},
  ): Promise<RenewExpiryItemResponse> {
    return this.transport.request<RenewExpiryItemResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items/${encodeURIComponent(itemId)}/renew`,
        body,
      },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/expiry-items/:itemId — a soft archive. */
  archive(
    orgId: string,
    itemId: string,
    opts: RequestOptions = {},
  ): Promise<ArchiveExpiryItemResponse> {
    return this.transport.request<ArchiveExpiryItemResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items/${encodeURIComponent(itemId)}`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/expiry-items/:itemId/reminders */
  reminders(
    orgId: string,
    itemId: string,
    opts: RequestOptions = {},
  ): Promise<ListExpiryRemindersResponse> {
    return this.transport.request<ListExpiryRemindersResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items/${encodeURIComponent(itemId)}/reminders`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/expiry-templates — the vertical catalogue. */
  templates(orgId: string, opts: RequestOptions = {}): Promise<ListExpiryTemplatesResponse> {
    return this.transport.request<ListExpiryTemplatesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-templates`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/expiry-templates/:key/apply
   *
   * Fans one vertical out into its tracked items (each with its ladder) in one
   * call. Pass `idempotencyKey` in `opts` so a retried click does not double it.
   */
  applyTemplate(
    orgId: string,
    templateKey: string,
    body: ApplyExpiryTemplateRequest = {},
    opts: RequestOptions = {},
  ): Promise<ApplyExpiryTemplateResponse> {
    return this.transport.request<ApplyExpiryTemplateResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-templates/${encodeURIComponent(templateKey)}/apply`,
        body,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/expiry-scorecard — compliance per location. */
  scorecard(orgId: string, opts: RequestOptions = {}): Promise<GetExpiryScorecardResponse> {
    return this.transport.request<GetExpiryScorecardResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-scorecard`,
      },
      opts,
    );
  }
}
