'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { adsKeys, toMajorUnits, toMinorUnits, type AdCampaign } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { Can } from '@/lib/permissions';

function localInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Pause, resume, end, duplicate, and the budget and end date of a campaign at Meta (feature 007 US5, FR-016 – FR-019). */
export function AdManage({ campaign }: { campaign: AdCampaign }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [budget, setBudget] = useState(String(toMajorUnits(campaign.dailyBudgetMinor, campaign.currency)));
  const [endAt, setEndAt] = useState(localInput(campaign.endAt));
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: adsKeys.campaign(campaign.id) }), queryClient.invalidateQueries({ queryKey: adsKeys.campaigns })]);
  const act = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'end') => api<AdCampaign>(`/ads/campaigns/${campaign.id}/${action}`, { method: 'POST' }),
    onSuccess: async (_, action) => {
      toast.success(action === 'pause' ? 'Paused at Meta' : action === 'resume' ? 'Running again' : 'Campaign ended');
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const duplicate = useMutation({
    mutationFn: () => api<AdCampaign>(`/ads/campaigns/${campaign.id}/duplicate`, { method: 'POST' }),
    onSuccess: async (copy) => {
      toast.success('Copied as a draft');
      await queryClient.invalidateQueries({ queryKey: adsKeys.campaigns });
      router.push(`/ads/${copy.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const change = useMutation({
    mutationFn: (json: { dailyBudgetMinor?: number; endAt?: string | null }) => api<AdCampaign>(`/ads/campaigns/${campaign.id}`, { method: 'PATCH', json }),
    onSuccess: async () => {
      toast.success('Saved at Meta');
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const major = Number(budget);
    if (!Number.isFinite(major) || major <= 0) return toast.error('Enter a positive daily budget.');
    const json: { dailyBudgetMinor?: number; endAt?: string | null } = {};
    const minor = toMinorUnits(major, campaign.currency);
    if (minor !== campaign.dailyBudgetMinor) json.dailyBudgetMinor = minor;
    const nextEnd = endAt ? new Date(endAt).toISOString() : null;
    if ((nextEnd ?? null) !== (campaign.endAt ?? null) && localInput(campaign.endAt) !== endAt) json.endAt = nextEnd;
    if (!Object.keys(json).length) return toast.success('Nothing changed');
    change.mutate(json);
  }

  const running = campaign.status === 'IN_REVIEW' || campaign.status === 'ACTIVE' || campaign.status === 'ERROR';
  const atMeta = ['IN_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'ERROR'].includes(campaign.status);

  return (
    <Card data-testid="ad-manage">
      <CardHeader>
        <CardTitle className="text-base">Manage</CardTitle>
        <CardDescription>Changes go to Meta at once. Changes made in Meta&apos;s tools show here at the next update.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <Can permission="campaigns.launch">
            {running ? (
              <Button variant="outline" onClick={() => act.mutate('pause')} disabled={act.isPending}>
                Pause
              </Button>
            ) : null}
            {campaign.status === 'PAUSED' ? (
              <Button onClick={() => act.mutate('resume')} disabled={act.isPending}>
                Resume
              </Button>
            ) : null}
            {atMeta ? (
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" className="text-destructive">
                    End campaign
                  </Button>
                }
                title="End this campaign?"
                description="It stops at Meta now and cannot run again; its results stay. Duplicate it to run it again."
                confirmLabel="End campaign"
                confirmVariant="destructive"
                onConfirm={() => act.mutateAsync('end').catch(() => undefined)}
              />
            ) : null}
          </Can>
          <Can permission="campaigns.manage">
            <Button variant="outline" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}>
              Duplicate
            </Button>
          </Can>
        </div>
        {atMeta ? (
          <Can permission="campaigns.launch">
            <form onSubmit={submit} className="flex flex-wrap items-end gap-2 border-t pt-4">
              <div className="grid gap-1.5">
                <Label htmlFor="manage-budget">Daily budget ({campaign.currency})</Label>
                <Input id="manage-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className="w-36" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="manage-end">End (optional)</Label>
                <Input id="manage-end" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
              </div>
              <Button type="submit" variant="outline" disabled={change.isPending}>
                Save budget and dates
              </Button>
              <p className="w-full text-xs text-muted-foreground">Higher budgets are checked against the monthly spending cap.</p>
            </form>
          </Can>
        ) : null}
      </CardContent>
    </Card>
  );
}
