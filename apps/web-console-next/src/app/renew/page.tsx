"use client";

import * as React from "react";
import { CalendarCheck2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { createClient, wrap } from "@/lib/api";
import type { PublicRenewalFormResponse } from "@saas/contracts/expiry";

/**
 * The holder's renewal page (EX3). Public: no sign-in, no account. The token in
 * the URL is the only authorization, and it works once. The client is built
 * WITHOUT the console's session token, so nothing about the viewer is sent.
 */
export default function RenewPage() {
  const { target } = useSession();
  const client = React.useMemo(() => createClient(target, null), [target]);
  const [token, setToken] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<PublicRenewalFormResponse | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "gone" | "done">("loading");
  const [expiresOn, setExpiresOn] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    setToken(t);
    if (!t) {
      setState("gone");
      return;
    }
    void (async () => {
      const r = await wrap(async () => client.expiry.renewalForm(t));
      if (!r.ok) {
        setState("gone");
        return;
      }
      setForm(r.data);
      setState("ready");
    })();
  }, [client]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !expiresOn) return;
    if (file && form && file.size > form.maxDocumentBytes) {
      setError("That file is larger than 10 MB.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await wrap(async () => client.expiry.submitRenewal(token, expiresOn, file));
    setBusy(false);
    if (!r.ok) {
      if (r.status === 404) setState("gone");
      else setError(r.error.message);
      return;
    }
    setState("done");
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        {state === "loading" ? (
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64 mt-2" />
          </CardHeader>
        ) : state === "gone" ? (
          <CardHeader>
            <CardTitle>This link is not valid any more</CardTitle>
            <CardDescription>
              Renewal links work once and lapse after 14 days. Ask whoever sent it for a new one.
            </CardDescription>
          </CardHeader>
        ) : state === "done" ? (
          <CardHeader>
            <CalendarCheck2 className="h-8 w-8 text-success" />
            <CardTitle>Renewed — thank you</CardTitle>
            <CardDescription>
              {form?.item.name} now expires {expiresOn}. The reminders for the old date have been cancelled.
            </CardDescription>
          </CardHeader>
        ) : (
          <>
            <CardHeader>
              <CardTitle>Renew {form?.item.name}</CardTitle>
              <CardDescription>
                {form?.item.holderName ? `For ${form.item.holderName}. ` : ""}
                Currently expires {form?.item.expiresOn}
                {form?.item.issuer ? ` · ${form.item.issuer}` : ""}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="new-expiry">New expiry date</Label>
                  <Input id="new-expiry" type="date" required value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="new-card">Photo or PDF of the new card (optional)</Label>
                  <Input
                    id="new-card"
                    type="file"
                    accept={(form?.acceptedContentTypes ?? []).join(",")}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button type="submit" className="w-full" loading={busy} disabled={!expiresOn}>
                  Submit renewal
                </Button>
                <p className="text-xs text-muted-foreground">
                  This link works once. It lapses {form ? new Date(form.linkExpiresAt).toLocaleDateString() : ""}.
                </p>
              </form>
            </CardContent>
          </>
        )}
      </Card>
    </main>
  );
}
