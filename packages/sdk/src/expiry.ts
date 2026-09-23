import type {
  CreateExpiryFeedRequest,
  CreateExpiryFeedResponse,
  CreateExpiryRenewalLinkResponse,
  ListExpiryDocumentsResponse,
  ListExpiryFeedsResponse,
  PublicRenewalFormResponse,
  PublicRenewalSubmitResponse,
  RevokeExpiryFeedResponse,
  UploadExpiryDocumentResponse,
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

  // --- EX3: documents -------------------------------------------------------

  /** GET /v1/organizations/:orgId/expiry-items/:itemId/documents */
  documents(orgId: string, itemId: string, opts: RequestOptions = {}): Promise<ListExpiryDocumentsResponse> {
    return this.transport.request<ListExpiryDocumentsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items/${encodeURIComponent(itemId)}/documents`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/expiry-items/:itemId/documents — the body is
   * the file itself (PDF or image, at most 10 MB).
   */
  uploadDocument(
    orgId: string,
    itemId: string,
    file: Blob,
    filename: string,
    opts: RequestOptions = {},
  ): Promise<UploadExpiryDocumentResponse> {
    return this.transport.request<UploadExpiryDocumentResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items/${encodeURIComponent(itemId)}/documents`,
        query: { filename },
        rawBody: file,
        contentType: file.type || "application/octet-stream",
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/expiry-documents/:documentId/content — the raw bytes. */
  async documentContent(orgId: string, documentId: string, opts: RequestOptions = {}): Promise<Blob> {
    const res = await this.transport.requestBinary(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-documents/${encodeURIComponent(documentId)}/content`,
      },
      opts,
    );
    return res.blob();
  }

  // --- EX3: the renewal link ------------------------------------------------

  /** POST /v1/organizations/:orgId/expiry-items/:itemId/renewal-links — the token is returned once. */
  createRenewalLink(
    orgId: string,
    itemId: string,
    opts: RequestOptions = {},
  ): Promise<CreateExpiryRenewalLinkResponse> {
    return this.transport.request<CreateExpiryRenewalLinkResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-items/${encodeURIComponent(itemId)}/renewal-links`,
        body: {},
      },
      opts,
    );
  }

  /** GET /ingress/expirio/renew?token= — public, no session. */
  renewalForm(token: string, opts: RequestOptions = {}): Promise<PublicRenewalFormResponse> {
    return this.transport.request<PublicRenewalFormResponse>(
      { method: "GET", path: "/ingress/expirio/renew", query: { token } },
      opts,
    );
  }

  /** POST /ingress/expirio/renew — public; multipart when a document rides along. */
  submitRenewal(
    token: string,
    expiresOn: string,
    file: Blob | null = null,
    opts: RequestOptions = {},
  ): Promise<PublicRenewalSubmitResponse> {
    if (!file) {
      return this.transport.request<PublicRenewalSubmitResponse>(
        { method: "POST", path: "/ingress/expirio/renew", body: { token, expiresOn } },
        opts,
      );
    }
    const form = new FormData();
    form.set("token", token);
    form.set("expiresOn", expiresOn);
    form.set("file", file);
    return this.transport.request<PublicRenewalSubmitResponse>(
      // The runtime sets the multipart boundary; an explicit content-type would drop it.
      { method: "POST", path: "/ingress/expirio/renew", rawBody: form, contentType: "" },
      opts,
    );
  }

  // --- EX3: the calendar feed -----------------------------------------------

  /** GET /v1/organizations/:orgId/expiry-feeds */
  feeds(orgId: string, opts: RequestOptions = {}): Promise<ListExpiryFeedsResponse> {
    return this.transport.request<ListExpiryFeedsResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-feeds` },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/expiry-feeds — the token is returned once. */
  createFeed(orgId: string, body: CreateExpiryFeedRequest, opts: RequestOptions = {}): Promise<CreateExpiryFeedResponse> {
    return this.transport.request<CreateExpiryFeedResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-feeds`, body },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/expiry-feeds/:feedId — revoke; the ICS URL answers 404 after. */
  revokeFeed(orgId: string, feedId: string, opts: RequestOptions = {}): Promise<RevokeExpiryFeedResponse> {
    return this.transport.request<RevokeExpiryFeedResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/expiry-feeds/${encodeURIComponent(feedId)}`,
      },
      opts,
    );
  }
}
