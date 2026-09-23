"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import type { PublicExpiryItem } from "@saas/contracts/expiry";
import { actionKey } from "./expiry-ui";

export function RenewDialog({
  orgId,
  item,
  onClose,
  onRenewed,
}: {
  orgId: string;
  item: PublicExpiryItem | null;
  onClose: () => void;
  onRenewed: (item: PublicExpiryItem) => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [expiresOn, setExpiresOn] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setExpiresOn(""), [item?.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item || !expiresOn) return;
    setBusy(true);
    const r = await wrap(async () =>
      (await client.expiry.renew(orgId, item.id, { expiresOn }, { idempotencyKey: actionKey("renew") })).item,
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Renew failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Renewed ${item.name}`, description: `New expiry ${expiresOn}` });
    onRenewed(r.data);
  };

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renew {item?.name}</DialogTitle>
          <DialogDescription>
            Record the new expiry date. Unsent reminders for the old date are cancelled and a new
            ladder is scheduled.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="renew-expires">New expiry date</Label>
            <Input
              id="renew-expires"
              type="date"
              required
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!expiresOn}>
              Renew
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
