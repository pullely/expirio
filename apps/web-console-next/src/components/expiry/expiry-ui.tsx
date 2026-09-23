"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import type { ExpiryItemStatus } from "@saas/contracts/expiry";

/** The register's primary column: how long is left, coloured by the ladder's thresholds. */
export function DaysBadge({ days }: { days: number }) {
  if (days < 0) return <Badge variant="destructive">{Math.abs(days)}d overdue</Badge>;
  if (days === 0) return <Badge variant="destructive">today</Badge>;
  if (days <= 7) return <Badge variant="destructive">{days}d</Badge>;
  if (days <= 30) return <Badge variant="warning">{days}d</Badge>;
  if (days <= 90) return <Badge variant="default">{days}d</Badge>;
  return <Badge variant="secondary">{days}d</Badge>;
}

const STATUS_VARIANT: Record<ExpiryItemStatus, "success" | "warning" | "destructive" | "secondary" | "default"> = {
  active: "success",
  expiring: "warning",
  expired: "destructive",
  renewed: "default",
  archived: "secondary",
};

export function StatusBadge({ status }: { status: ExpiryItemStatus }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "secondary"}>{status}</Badge>;
}

/** Project (location) id → name, for rendering the location column. */
export function useLocationNames(orgId: string): Map<string, string> {
  const { client } = useSession();
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  return React.useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name] as const)),
    [projects.data],
  );
}

export function locationLabel(names: Map<string, string>, projectId: string | null): string {
  if (!projectId) return "Organization-wide";
  return names.get(projectId) ?? projectId;
}

/** Idempotency key for one user action — a retried click replays, a new click does not. */
export function actionKey(scope: string): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return `${scope}-${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
