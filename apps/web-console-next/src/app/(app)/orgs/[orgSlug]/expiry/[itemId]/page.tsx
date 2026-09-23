"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { DaysBadge, StatusBadge, locationLabel, useLocationNames } from "@/components/expiry/expiry-ui";
import { RenewDialog } from "@/components/expiry/renew-dialog";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import type { ExpiryReminderStatus } from "@saas/contracts/expiry";

export default function ExpiryItemPage() {
  const params = useParams<{ orgSlug: string; itemId: string }>();
  const slug = params?.orgSlug ?? "";
  const itemId = params?.itemId ?? "";
  return (
    <OrgScope slug={slug}>{(org) => <Item orgId={org.id} orgSlug={org.slug} itemId={itemId} />}</OrgScope>
  );
}

const REMINDER_VARIANT: Record<ExpiryReminderStatus, "success" | "secondary" | "destructive" | "default"> = {
  pending: "default",
  sent: "success",
  skipped: "secondary",
  failed: "destructive",
};

function Item({ orgId, orgSlug, itemId }: { orgId: string; orgSlug: string; itemId: string }) {
  const { client } = useSession();
  const locations = useLocationNames(orgId);
  const item = useApiQuery(qk.expiryItem(orgId, itemId), () =>
    wrap(async () => (await client.expiry.get(orgId, itemId)).item),
  );
  const ladder = useApiQuery(qk.expiryReminders(orgId, itemId), () =>
    wrap(async () => (await client.expiry.reminders(orgId, itemId)).reminders),
  );
  const [renewOpen, setRenewOpen] = React.useState(false);

  if (item.loading) return <Skeleton className="h-40 w-full" />;
  if (item.error || !item.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">{item.error?.code ?? "not_found"}</CardTitle>
          <CardDescription>{item.error?.message ?? "This item does not exist."}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const it = item.data;
  const facts: Array<[string, React.ReactNode]> = [
    ["Kind", it.kind],
    ["Issuer", it.issuer ?? "—"],
    ["Number", it.identifier ?? "—"],
    ["Holder", it.holderName ? `${it.holderName}${it.holderEmail ? ` · ${it.holderEmail}` : ""}` : it.holderEmail ?? "—"],
    ["Manager", it.managerEmail ?? "—"],
    ["Location", locationLabel(locations, it.projectId)],
    ["Issued", it.issuedOn ?? "—"],
    ["Expires", it.expiresOn],
    ["Template", it.templateKey ?? "—"],
  ];

  return (
    <div className="space-y-5 max-w-4xl">
      <Link href={`/orgs/${orgSlug}/expiry`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" /> Register
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{it.name}</h1>
          <div className="flex items-center gap-2">
            <DaysBadge days={it.daysRemaining} />
            <StatusBadge status={it.status} />
          </div>
        </div>
        {it.status !== "archived" && <Button onClick={() => setRenewOpen(true)}>Renew</Button>}
      </header>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3 text-sm">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-medium break-words">{v}</dd>
              </div>
            ))}
          </dl>
          {it.notes && <p className="mt-4 text-sm text-muted-foreground whitespace-pre-wrap">{it.notes}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reminder ladder</CardTitle>
          <CardDescription>
            Holder at 90 and 60 days, manager at 30, owner at 7 and on the day. Sent once each, then kept as a record.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {ladder.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : (ladder.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No rungs scheduled — every one of them is already in the past.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Rung</TH>
                  <TH>Chases</TH>
                  <TH>Scheduled</TH>
                  <TH>State</TH>
                  <TH className="hidden md:table-cell">Sent to</TH>
                </TR>
              </THead>
              <TBody>
                {(ladder.data ?? []).map((r) => (
                  <TR key={r.id}>
                    <TD className="tabular-nums">{r.offsetDays === 0 ? "on the day" : `${r.offsetDays} days`}</TD>
                    <TD>{r.tier}</TD>
                    <TD className="tabular-nums">{r.scheduledFor}</TD>
                    <TD>
                      <Badge variant={REMINDER_VARIANT[r.status]}>{r.status}</Badge>
                    </TD>
                    <TD className="hidden md:table-cell">{r.recipient ?? "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RenewDialog
        orgId={orgId}
        item={renewOpen ? it : null}
        onClose={() => setRenewOpen(false)}
        onRenewed={() => {
          setRenewOpen(false);
          item.reload();
          ladder.reload();
        }}
      />
    </div>
  );
}
