"use client";

import * as React from "react";
import { Download, Link2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import {
  EXPIRY_DOCUMENT_CONTENT_TYPES,
  EXPIRY_DOCUMENT_MAX_BYTES,
  EXPIRY_RENEWAL_LINK_TTL_DAYS,
} from "@saas/contracts/expiry";
import { actionKey } from "./expiry-ui";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The item's scans and PDFs: list, upload, download (EX3). */
export function DocumentsPanel({ orgId, itemId }: { orgId: string; itemId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const docs = useApiQuery(qk.expiryDocuments(orgId, itemId), () =>
    wrap(async () => (await client.expiry.documents(orgId, itemId)).documents),
  );
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  const upload = async (file: File) => {
    if (file.size > EXPIRY_DOCUMENT_MAX_BYTES) {
      toast({ kind: "error", title: "Too large", description: "Documents are limited to 10 MB." });
      return;
    }
    setBusy(true);
    const r = await wrap(async () =>
      client.expiry.uploadDocument(orgId, itemId, file, file.name, { idempotencyKey: actionKey("doc") }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Upload failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Attached ${file.name}` });
    docs.reload();
  };

  const download = async (id: string, filename: string) => {
    const r = await wrap(async () => client.expiry.documentContent(orgId, id));
    if (!r.ok) {
      toast({ kind: "error", title: "Download failed", description: r.error.message });
      return;
    }
    const url = URL.createObjectURL(r.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Documents</CardTitle>
          <CardDescription>The certificate itself — a PDF or a photo, up to 10 MB.</CardDescription>
        </div>
        <input
          ref={input}
          type="file"
          className="hidden"
          accept={EXPIRY_DOCUMENT_CONTENT_TYPES.join(",")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
        <Button size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}>
          <Upload className="h-4 w-4 mr-1.5" /> Upload
        </Button>
      </CardHeader>
      <CardContent>
        {docs.loading ? (
          <Skeleton className="h-12 w-full" />
        ) : (docs.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents attached.</p>
        ) : (
          <ul className="divide-y">
            {(docs.data ?? []).map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium truncate">{d.filename}</div>
                  <div className="text-xs text-muted-foreground">
                    {size(d.sizeBytes)} · {new Date(d.uploadedAt).toLocaleDateString()}
                    {d.source === "renewal_link" ? " · via renewal link" : ""}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => download(d.id, d.filename)} aria-label={`Download ${d.filename}`}>
                  <Download className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Mint a single-use link the holder renews from without an account (EX3). */
export function RenewalLinkButton({ orgId, itemId }: { orgId: string; itemId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [url, setUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const mint = async () => {
    setBusy(true);
    const r = await wrap(async () =>
      client.expiry.createRenewalLink(orgId, itemId, { idempotencyKey: actionKey("link") }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not create the link", description: r.error.message });
      return;
    }
    setUrl(`${window.location.origin}${r.data.path}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Renewal link</CardTitle>
        <CardDescription>
          Send the holder a link to record the new date and attach the new card — no account, works once,
          lapses after {EXPIRY_RENEWAL_LINK_TTL_DAYS} days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" loading={busy} onClick={mint}>
          <Link2 className="h-4 w-4 mr-1.5" /> Create a renewal link
        </Button>
        {url && (
          <div className="rounded-md border p-3 space-y-1">
            <p className="text-xs text-muted-foreground">Copy it now — it is not shown again.</p>
            <div className="flex items-center gap-2">
              <code className="text-xs break-all flex-1">{url}</code>
              <CopyButton value={url} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
