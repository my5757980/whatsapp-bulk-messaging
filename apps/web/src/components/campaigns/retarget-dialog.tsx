'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { growthKeys, type RetargetGroup } from '@/lib/growth';
import type { Campaign } from '@/lib/types';

const GROUPS: Array<{ status: RetargetGroup; label: string; hint: string }> = [
  { status: 'CLICKED', label: 'Clicked', hint: 'Opened a tracked link' },
  { status: 'NOT_CLICKED', label: 'Not clicked', hint: 'Received it, opened no link' },
  { status: 'REPLIED', label: 'Replied', hint: 'Wrote back within 3 days of receiving it' },
  { status: 'NOT_REPLIED', label: 'Not replied', hint: 'Received it, did not write back' },
  { status: 'READ', label: 'Read', hint: 'Read the message' },
  { status: 'NOT_READ', label: 'Not read', hint: 'Sent or received, not read' },
  { status: 'DELIVERED', label: 'Delivered', hint: 'Received the message' },
  { status: 'FAILED', label: 'Failed', hint: 'The message failed' },
  { status: 'HELD_BACK', label: 'Held back', hint: "Held back by Meta's per-person marketing limit; send the next day" },
  { status: 'PAID', label: 'Paid', hint: 'Paid the payment request this campaign sent' },
  { status: 'NOT_PAID', label: 'Not paid', hint: 'Received the payment request and did not pay' },
];

/**
 * Retarget (001 FR-031, extended by feature 005 US2): pick a group, see how many contacts are in it,
 * and create a draft in one step. Empty groups cannot be chosen.
 */
export function RetargetDialog({ campaignId, open, onOpenChange }: { campaignId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [choice, setChoice] = useState<RetargetGroup | null>(null);
  const groups = useQuery({
    queryKey: growthKeys.retargetGroups(campaignId),
    queryFn: () => api<{ groups: Array<{ status: RetargetGroup; count: number; available: boolean }> }>(`/campaigns/${campaignId}/retarget-groups`),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: (status: RetargetGroup) => api<Campaign>(`/campaigns/${campaignId}/retarget`, { method: 'POST', json: { status } }),
    onSuccess: (draft) => {
      toast.success('Retarget draft created');
      router.push(`/campaigns/new?id=${draft.id}&step=2`);
    },
    onError: toastError,
  });
  const sizes = new Map((groups.data?.groups ?? []).map((g) => [g.status, g]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retarget</DialogTitle>
          <DialogDescription>Choose who gets the new campaign. Contacts who opted out are left out when it starts.</DialogDescription>
        </DialogHeader>
        {groups.isLoading ? <p className="text-sm text-muted-foreground">Counting…</p> : null}
        {groups.error ? <p className="text-sm text-destructive">{errorMessage(groups.error)}</p> : null}
        <div className="grid gap-2" role="radiogroup" aria-label="Retarget group">
          {GROUPS.map((g) => {
            const size = sizes.get(g.status);
            const available = size?.available ?? false;
            return (
              <label
                key={g.status}
                className={`flex items-center justify-between gap-3 rounded-md border p-3 text-sm ${available ? 'cursor-pointer' : 'opacity-50'}`}
                data-testid={`retarget-${g.status}`}
              >
                <span className="flex items-center gap-2">
                  <input type="radio" name="retarget-group" value={g.status} disabled={!available} checked={choice === g.status} onChange={() => setChoice(g.status)} />
                  <span>
                    <span className="font-medium">{g.label}</span>
                    <span className="block text-xs text-muted-foreground">{available ? g.hint : 'Nobody in this group'}</span>
                  </span>
                </span>
                <span className="font-semibold" data-testid={`retarget-count-${g.status}`}>
                  {formatNumber(size?.count ?? 0)}
                </span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!choice || create.isPending} onClick={() => choice && create.mutate(choice)}>
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
