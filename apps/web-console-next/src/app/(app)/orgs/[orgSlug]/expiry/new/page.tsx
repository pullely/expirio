"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PreconditionInsight } from "@/components/precondition/insight";
import { actionKey } from "@/components/expiry/expiry-ui";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import {
  EXPIRY_ITEM_KINDS,
  type CreateExpiryItemRequest,
  type ExpiryItemKind,
  type PublicExpiryTemplate,
} from "@saas/contracts/expiry";

export default function NewExpiryItemPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <NewItem orgId={org.id} orgSlug={org.slug} />}</OrgScope>;
}

function Field({
  id,
  label,
  children,
  hint,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const SELECT_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm sm:h-9 sm:text-sm";

function NewItem({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const templates = useApiQuery(qk.expiryTemplates(orgId), () =>
    wrap(async () => (await client.expiry.templates(orgId)).templates),
  );

  // Shared holder/location fields — the same person and site for both paths.
  const [projectId, setProjectId] = React.useState("");
  const [holderName, setHolderName] = React.useState("");
  const [holderEmail, setHolderEmail] = React.useState("");
  const [managerEmail, setManagerEmail] = React.useState("");

  const onError = (error: ApiErrorBody, title: string) => {
    if (error.code === "precondition_failed") setPrecondition(error);
    else toast({ kind: "error", title, description: error.message });
  };

  const people = (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="holder-name" label="Holder name">
        <Input id="holder-name" value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="Dr. Priya Ng" />
      </Field>
      <Field id="location" label="Location" hint="A project is a location — a clinic site, a depot.">
        <select id="location" className={SELECT_CLASS} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Organization-wide</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="holder-email" label="Holder email" hint="Reminded at 90 and 60 days.">
        <Input id="holder-email" type="email" value={holderEmail} onChange={(e) => setHolderEmail(e.target.value)} />
      </Field>
      <Field id="manager-email" label="Manager email" hint="Reminded at 30 days; the owner at 7 and on the day.">
        <Input id="manager-email" type="email" value={managerEmail} onChange={(e) => setManagerEmail(e.target.value)} />
      </Field>
    </div>
  );

  return (
    <div className="space-y-5 max-w-3xl">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Track an item</h1>
        <p className="text-sm text-muted-foreground">
          Every item gets a reminder ladder: holder at 90 and 60 days, manager at 30, owner at 7 and on the day.
        </p>
      </header>

      {precondition && (
        <PreconditionInsight error={precondition} resource="expiry item" onDismiss={() => setPrecondition(null)} />
      )}

      <Tabs defaultValue="template">
        <TabsList>
          <TabsTrigger value="template">From a template</TabsTrigger>
          <TabsTrigger value="manual">One item</TabsTrigger>
        </TabsList>

        <TabsContent value="template" className="space-y-4">
          {templates.loading ? (
            <Skeleton className="h-32 w-full" />
          ) : templates.error ? (
            <p className="text-sm text-destructive">{templates.error.message}</p>
          ) : (
            <TemplatePicker
              templates={templates.data ?? []}
              people={people}
              onApply={async (key, itemKeys, issuedOn) => {
                const r = await wrap(async () =>
                  client.expiry.applyTemplate(
                    orgId,
                    key,
                    {
                      itemKeys,
                      issuedOn: issuedOn || null,
                      projectId: projectId || null,
                      holderName: holderName || null,
                      holderEmail: holderEmail || null,
                      managerEmail: managerEmail || null,
                    },
                    { idempotencyKey: actionKey("apply") },
                  ),
                );
                if (!r.ok) return onError(r.error, "Could not apply the template");
                toast({
                  kind: "success",
                  title: `Tracking ${r.data.items.length} items`,
                  description: "Correct each expiry date from the real card on its item page.",
                });
                router.push(`/orgs/${orgSlug}/expiry`);
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="manual">
          <ManualForm
            people={people}
            onSubmit={async (fields) => {
              const body: CreateExpiryItemRequest = {
                ...fields,
                projectId: projectId || null,
                holderName: holderName || null,
                holderEmail: holderEmail || null,
                managerEmail: managerEmail || null,
              };
              const r = await wrap(async () =>
                (await client.expiry.create(orgId, body, { idempotencyKey: actionKey("create") })).item,
              );
              if (!r.ok) return onError(r.error, "Could not track the item");
              toast({ kind: "success", title: `Tracking ${r.data.name}` });
              router.push(`/orgs/${orgSlug}/expiry/${r.data.id}`);
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TemplatePicker({
  templates,
  people,
  onApply,
}: {
  templates: PublicExpiryTemplate[];
  people: React.ReactNode;
  onApply: (key: string, itemKeys: string[], issuedOn: string) => Promise<void>;
}) {
  const [key, setKey] = React.useState(templates[0]?.key ?? "");
  const template = templates.find((t) => t.key === key) ?? null;
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [issuedOn, setIssuedOn] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setPicked(new Set(template?.items.map((i) => i.key) ?? []));
  }, [template]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {templates.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setKey(t.key)}
            className="text-left"
            aria-pressed={t.key === key}
          >
            <Card className={t.key === key ? "border-primary ring-1 ring-primary" : "hover:border-primary/40"}>
              <CardHeader>
                <CardTitle className="text-base">{t.name}</CardTitle>
                <CardDescription className="text-xs">{t.description}</CardDescription>
              </CardHeader>
            </Card>
          </button>
        ))}
      </div>

      {template && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-2">
              {template.items.map((i) => (
                <label key={i.key} className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={picked.has(i.key)}
                    onCheckedChange={(on) =>
                      setPicked((cur) => {
                        const next = new Set(cur);
                        if (on) next.add(i.key);
                        else next.delete(i.key);
                        return next;
                      })
                    }
                  />
                  <span className="font-medium">{i.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {i.issuer ?? i.kind} · renews every {i.validityMonths} months
                  </span>
                </label>
              ))}
            </div>
            {people}
            <Field id="issued-on" label="Issued on" hint="Defaults to today. Each item's expiry is estimated from it.">
              <Input id="issued-on" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
            </Field>
            <Button
              loading={busy}
              disabled={picked.size === 0}
              onClick={async () => {
                setBusy(true);
                await onApply(template.key, [...picked], issuedOn);
                setBusy(false);
              }}
            >
              Track {picked.size} item{picked.size === 1 ? "" : "s"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ManualForm({
  people,
  onSubmit,
}: {
  people: React.ReactNode;
  onSubmit: (fields: {
    name: string;
    kind: ExpiryItemKind;
    expiresOn: string;
    issuer: string | null;
    identifier: string | null;
    issuedOn: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<ExpiryItemKind>("license");
  const [expiresOn, setExpiresOn] = React.useState("");
  const [issuedOn, setIssuedOn] = React.useState("");
  const [issuer, setIssuer] = React.useState("");
  const [identifier, setIdentifier] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <Card>
      <CardContent className="pt-6">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await onSubmit({
              name,
              kind,
              expiresOn,
              issuer: issuer || null,
              identifier: identifier || null,
              issuedOn: issuedOn || null,
            });
            setBusy(false);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="name" label="Name">
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="State pharmacy licence" />
            </Field>
            <Field id="kind" label="Kind">
              <select id="kind" className={SELECT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as ExpiryItemKind)}>
                {EXPIRY_ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="expires-on" label="Expires on">
              <Input id="expires-on" type="date" required value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </Field>
            <Field id="manual-issued-on" label="Issued on">
              <Input id="manual-issued-on" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
            </Field>
            <Field id="issuer" label="Issuer">
              <Input id="issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Texas Medical Board" />
            </Field>
            <Field id="identifier" label="Licence / policy number" hint="Never included in a reminder email.">
              <Input id="identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
            </Field>
          </div>
          {people}
          <Button type="submit" loading={busy} disabled={!name || !expiresOn}>
            Track item
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
