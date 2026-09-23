"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { locationLabel, useLocationNames } from "@/components/expiry/expiry-ui";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import type { GetExpiryScorecardResponse } from "@saas/contracts/expiry";

export default function ExpiryScorecardPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Scorecard orgId={org.id} orgSlug={org.slug} />}</OrgScope>;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV is built from the same payload the table renders — one source of truth for an audit. */
function toCsv(card: GetExpiryScorecardResponse, names: Map<string, string>): string {
  const header = ["location", "total", "active", "expiring", "expired", "renewed", "due_within_30_days", "compliant_percent"];
  const lines = card.locations.map((r) =>
    [locationLabel(names, r.projectId), r.total, r.active, r.expiring, r.expired, r.renewed, r.dueWithin30, r.compliantPercent]
      .map(csvCell)
      .join(","),
  );
  const t = card.totals;
  lines.push(["All locations", t.total, t.active, t.expiring, t.expired, t.renewed, t.dueWithin30, t.compliantPercent].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}

function Scorecard({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const names = useLocationNames(orgId);
  const card = useApiQuery(qk.expiryScorecard(orgId), () =>
    wrap(async () => client.expiry.scorecard(orgId)),
  );

  const download = () => {
    if (!card.data) return;
    const blob = new Blob([toCsv(card.data, names)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compliance-scorecard-${card.data.asOf}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <Link href={`/orgs/${orgSlug}/expiry`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" /> Register
      </Link>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Compliance scorecard</h1>
          <p className="text-sm text-muted-foreground">
            Per location: what is valid, what is lapsing inside {card.data?.horizonDays ?? 30} days, what has lapsed.
          </p>
        </div>
        <Button variant="outline" onClick={download} disabled={!card.data}>
          <Download className="h-4 w-4 mr-1.5" /> CSV
        </Button>
      </header>

      {card.loading ? (
        <Skeleton className="h-40 w-full" />
      ) : card.error || !card.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{card.error?.code}</CardTitle>
            <CardDescription>{card.error?.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            {[
              ["Compliant", `${card.data.totals.compliantPercent}%`],
              ["Tracked", card.data.totals.total],
              ["Due in 30 days", card.data.totals.dueWithin30],
              ["Expired", card.data.totals.expired],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardHeader className="pb-2">
                  <CardDescription>{label}</CardDescription>
                  <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
                </CardHeader>
              </Card>
            ))}
          </div>
          <Card className="overflow-x-auto">
            <CardContent className="pt-6">
              {card.data.locations.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing tracked yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Location</TH>
                      <TH className="text-right">Compliant</TH>
                      <TH className="text-right">Tracked</TH>
                      <TH className="text-right">Active</TH>
                      <TH className="text-right">Expiring</TH>
                      <TH className="text-right">Expired</TH>
                      <TH className="text-right">Due ≤30d</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {card.data.locations.map((r) => (
                      <TR key={r.projectId ?? "org"}>
                        <TD className="font-medium">{locationLabel(names, r.projectId)}</TD>
                        <TD className="text-right tabular-nums">{r.compliantPercent}%</TD>
                        <TD className="text-right tabular-nums">{r.total}</TD>
                        <TD className="text-right tabular-nums">{r.active}</TD>
                        <TD className="text-right tabular-nums">{r.expiring}</TD>
                        <TD className="text-right tabular-nums">{r.expired}</TD>
                        <TD className="text-right tabular-nums">{r.dueWithin30}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
