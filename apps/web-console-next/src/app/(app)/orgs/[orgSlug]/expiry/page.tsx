"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CalendarClock, Plus, ShieldCheck } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import {
  DaysBadge,
  StatusBadge,
  locationLabel,
  useLocationNames,
} from "@/components/expiry/expiry-ui";
import { RenewDialog } from "@/components/expiry/renew-dialog";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import type { PublicExpiryItem } from "@saas/contracts/expiry";

const STATUS_FILTERS = ["", "active", "expiring", "expired", "archived"] as const;

export default function ExpiryRegisterPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Register orgId={org.id} orgSlug={org.slug} />}</OrgScope>;
}

function Register({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const [status, setStatus] = React.useState<(typeof STATUS_FILTERS)[number]>("");
  const locations = useLocationNames(orgId);
  const items = useApiQuery(qk.expiryItems(orgId, status), () =>
    wrap(async () => (await client.expiry.list(orgId, status ? { status, limit: 100 } : { limit: 100 })).items),
  );
  const [renewing, setRenewing] = React.useState<PublicExpiryItem | null>(null);

  // Soonest first: the register is read top-down as "what do I chase today".
  const rows = React.useMemo(
    () => [...(items.data ?? [])].sort((a, b) => a.daysRemaining - b.daysRemaining),
    [items.data],
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Expiry register</h1>
          <p className="text-sm text-muted-foreground">
            Every licence, certification and policy you track, soonest to lapse first.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/orgs/${orgSlug}/expiry/scorecard`}>
              <ShieldCheck className="h-4 w-4 mr-1.5" />
              Scorecard
            </Link>
          </Button>
          <Button asChild>
            <Link href={`/orgs/${orgSlug}/expiry/new`}>
              <Plus className="h-4 w-4 mr-1.5" />
              Track an item
            </Link>
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by status">
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s || "all"}
            size="sm"
            variant={status === s ? "default" : "outline"}
            onClick={() => setStatus(s)}
            role="tab"
            aria-selected={status === s}
          >
            {s || "All current"}
          </Button>
        ))}
      </div>

      {items.loading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64 mt-2" />
          </CardHeader>
        </Card>
      ) : items.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{items.error.code}</CardTitle>
            <CardDescription>{items.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nothing tracked yet"
          description="Add a licence by hand, or start from the clinic, trades or childcare template."
        />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Left</TH>
                <TH>Item</TH>
                <TH className="hidden md:table-cell">Holder</TH>
                <TH className="hidden md:table-cell">Location</TH>
                <TH>Expires</TH>
                <TH>Status</TH>
                <TH className="text-right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((item) => (
                <TR key={item.id}>
                  <TD>
                    <DaysBadge days={item.daysRemaining} />
                  </TD>
                  <TD>
                    <Link className="font-medium hover:underline" href={`/orgs/${orgSlug}/expiry/${item.id}`}>
                      {item.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{item.kind}</div>
                  </TD>
                  <TD className="hidden md:table-cell">{item.holderName ?? "—"}</TD>
                  <TD className="hidden md:table-cell">{locationLabel(locations, item.projectId)}</TD>
                  <TD className="tabular-nums">{item.expiresOn}</TD>
                  <TD>
                    <StatusBadge status={item.status} />
                  </TD>
                  <TD className="text-right">
                    {item.status !== "archived" && (
                      <Button size="sm" variant="outline" onClick={() => setRenewing(item)}>
                        Renew
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <RenewDialog
        orgId={orgId}
        item={renewing}
        onClose={() => setRenewing(null)}
        onRenewed={() => {
          setRenewing(null);
          items.reload();
        }}
      />
    </div>
  );
}
