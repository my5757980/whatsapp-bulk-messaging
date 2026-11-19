'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { toastError } from '@/lib/errors';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Campaign } from '@/lib/types';

/** Pause, resume and cancel with confirmations (T112). Hidden for roles without campaigns.launch. */
export function CampaignControls({ campaign }: { campaign: Campaign }) {
  const queryClient = useQueryClient();
  const act = (action: 'pause' | 'resume' | 'cancel', done: string) =>
    api<Campaign>(`/campaigns/${campaign.id}/${action}`, { method: 'POST' })
      .then(() => {
        toast.success(done);
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.campaign(campaign.id) }),
          queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
        ]);
      })
      .catch(toastError);

  const canCancel = campaign.state === 'RUNNING' || campaign.state === 'PAUSED' || campaign.state === 'SCHEDULED';
  return (
    <Can permission="campaigns.launch">
      <div className="flex flex-wrap gap-2">
        {campaign.state === 'RUNNING' ? (
          <ConfirmDialog
            trigger={<Button variant="secondary">Pause</Button>}
            title="Pause this campaign?"
            description="Sending stops within a few seconds. Recipients not yet sent stay queued until you resume."
            confirmLabel="Pause"
            onConfirm={() => act('pause', 'Campaign paused')}
          />
        ) : null}
        {campaign.state === 'PAUSED' ? (
          <ConfirmDialog
            trigger={<Button>Resume</Button>}
            title="Resume this campaign?"
            description="Only recipients who have not been sent the message yet will receive it."
            confirmLabel="Resume"
            onConfirm={() => act('resume', 'Campaign resumed')}
          />
        ) : null}
        {canCancel ? (
          <ConfirmDialog
            trigger={<Button variant="outline">Cancel campaign</Button>}
            title="Cancel this campaign?"
            description="Recipients not yet sent will not receive the message. This cannot be undone."
            confirmLabel="Cancel campaign"
            confirmVariant="destructive"
            onConfirm={() => act('cancel', 'Campaign cancelled')}
          />
        ) : null}
      </div>
    </Can>
  );
}

/** Banner explaining why a campaign is paused (FR-027). */
export function PausedBanner({ campaign }: { campaign: Campaign }) {
  if (campaign.state !== 'PAUSED') return null;
  const automatic = campaign.pausedReason && campaign.pausedReason !== 'manual';
  return (
    <div role="status" className="rounded-md border border-warning bg-warning/10 p-4 text-sm">
      <div className="font-medium">{automatic ? 'Paused automatically' : 'Paused'}</div>
      <div className="text-muted-foreground">
        {automatic ? `Sending stopped because ${campaign.pausedReasonText}. Fix the cause, then resume.` : 'A user paused this campaign.'}
      </div>
    </div>
  );
}
