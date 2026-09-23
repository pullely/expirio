"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { actionKey, locationLabel, useLocationNames } from "@/components/expiry/expiry-ui";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";

export default function ExpiryFeedsSettingsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Feeds orgId={org.id} />}</OrgScope>;
}

const SELECT_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm sm:h-9 sm:text-sm";

function Feeds({ orgId }: { orgId: string }) {
  const { client, target } = useSession();
  const { toast } = useToast();
  const names = useLocationNames(orgId);
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const feeds = useApiQuery(qk.expiryFeeds(orgId), () =>
    wrap(async () => (await client.expiry.feeds(orgId)).feeds),
  );
  const [label, setLabel] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // The subscription URL is shown exactly once — only its hash is stored.
  const [minted, setMinted] = React.useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await wrap(async () =>
      client.expiry.createFeed(orgId, { label, projectId: projectId || null }, { idempotencyKey: actionKey("feed") }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not create the feed", description: r.error.message });
      return;
    }
    setMinted(`${target.url.replace(/\/+$/, "")}${r.data.path}`);
    setLabel("");
    feeds.reload();
  };

  const revoke = async (feedId: string) => {
    const r = await wrap(async () => client.expiry.revokeFeed(orgId, feedId));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Feed revoked", description: "Its calendar URL now answers not found." });
    feeds.reload();
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Calendar feeds</h1>
        <p className="text-sm text-muted-foreground">
          Subscribe Google Calendar, Outlook or Apple Calendar to every upcoming expiry. A feed carries each
          item&apos;s name, kind and date — never a licence number or an email address.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New feed</CardTitle>
          <CardDescription>One per location, or one for the whole organization.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="feed-label">Label</Label>
              <Input id="feed-label" required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Front desk calendar" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="feed-location">Location</Label>
              <select id="feed-location" className={SELECT_CLASS} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Whole organization</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" loading={busy} disabled={!label}>
              Create feed
            </Button>
          </form>
          {minted && (
            <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 space-y-2">
              <p className="text-sm font-medium">Copy this URL now — it is not shown again.</p>
              <div className="flex items-center gap-2">
                <code className="text-xs break-all flex-1">{minted}</code>
                <CopyButton value={minted} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {feeds.loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (feeds.data ?? []).length === 0 ? (
        <EmptyState icon={CalendarClock} title="No feeds yet" description="Create one above and paste its URL into your calendar." />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Label</TH>
                <TH>Location</TH>
                <TH className="hidden md:table-cell">Last read</TH>
                <TH>State</TH>
                <TH className="text-right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {(feeds.data ?? []).map((f) => (
                <TR key={f.id}>
                  <TD className="font-medium">{f.label}</TD>
                  <TD>{locationLabel(names, f.projectId)}</TD>
                  <TD className="hidden md:table-cell">{f.lastUsedAt ? new Date(f.lastUsedAt).toLocaleString() : "never"}</TD>
                  <TD>
                    <Badge variant={f.revokedAt ? "secondary" : "success"}>{f.revokedAt ? "revoked" : "live"}</Badge>
                  </TD>
                  <TD className="text-right">
                    {!f.revokedAt && (
                      <Button size="sm" variant="outline" onClick={() => revoke(f.id)}>
                        Revoke
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
