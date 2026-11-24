'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { toastError } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { growthKeys, type RetargetGroup, type RetryPlan, type RetryRound, type RetryRoundStatus } from '@/lib/growth';
import { Can } from '@/lib/permissions';
import { waitLabel } from './retry-plan-form';

export const ROUND_STATUS: Record<RetryRoundStatus, string> = {
  SCHEDULED: 'Scheduled',
  RUNNING: 'Sending',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
  SKIPPED: 'Skipped',
};

/**
 * A campaign's retry rounds (feature 005 US3, FR-016 - FR-018): when each round runs, how many it
 * sends again and recovers, and the messages Meta held back for a retarget the next day.
 */
export function RetryRoundsPanel({ campaignId, state }: { campaignId: string; state: string }) {
  const queryClient = useQueryClient();
  const live = state === 'RUNNING' || state === 'PAUSED';
  const plan = useQuery({ queryKey: growthKeys.retryPlan(campaignId), queryFn: () => api<RetryPlan>(`/campaigns/${campaignId}/retry-plan`) });
  const rounds = useQuery({
    queryKey: growthKeys.retryRounds(campaignId),
    queryFn: () => api<RetryRound[]>(`/campaigns/${campaignId}/retry-rounds`),
    refetchInterval: live ? 5_000 : false,
  });
  const groups = useQuery({
    queryKey: growthKeys.retargetGroups(campaignId),
    queryFn: () => api<{ groups: Array<{ status: RetargetGroup; count: number }> }>(`/campaigns/${campaignId}/retarget-groups`),
    refetchInterval: live ? 5_000 : false,
  });
  const heldBack = groups.data?.groups.find((g) => g.status === 'HELD_BACK')?.count ?? 0;
  if (!plan.data || (plan.data.rounds === 0 && heldBack === 0)) return null;

  const cancel = (round: number) =>
    api(`/campaigns/${campaignId}/retry-rounds/${round}/cancel`, { method: 'POST' })
      .then(() => {
        toast.success(`Round ${round} cancelled`);
        return queryClient.invalidateQueries({ queryKey: growthKeys.retryRounds(campaignId) });
      })
      .catch(toastError);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Retries</CardTitle>
        <CardDescription>
          {plan.data.rounds
            ? `${plan.data.rounds} ${plan.data.rounds === 1 ? 'round' : 'rounds'}: ${plan.data.delaysMinutes.map(waitLabel).join(', then ')} after the previous sending. Only failures that may pass are sent again.`
            : 'No retries for this campaign.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 p-0 pb-4">
        {plan.data.rounds ? (
          rounds.data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Round</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">To send again</TableHead>
                  <TableHead className="text-right">Recovered</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rounds.data.map((r) => (
                  <TableRow key={r.round} data-testid={`retry-round-${r.round}`}>
                    <TableCell>Round {r.round}</TableCell>
                    <TableCell>
                      {ROUND_STATUS[r.status]}
                      {r.note ? <span className="block text-xs text-muted-foreground">{r.note}</span> : null}
                    </TableCell>
                    <TableCell>{formatDateTime(r.startedAt ?? r.dueAt)}</TableCell>
                    <TableCell className="text-right" data-testid="retry-round-recipients">
                      {formatNumber(r.recipients)}
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(r.recovered)}</TableCell>
                    <TableCell className="text-right">
                      {r.status === 'SCHEDULED' ? (
                        <Can permission="campaigns.launch">
                          <ConfirmDialog
                            trigger={
                              <Button variant="ghost" size="sm">
                                Cancel round
                              </Button>
                            }
                            title={`Cancel round ${r.round}?`}
                            description="These messages will not be sent again, and no later round runs. The campaign then completes."
                            confirmLabel="Cancel round"
                            onConfirm={() => cancel(r.round)}
                          />
                        </Can>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="px-6 text-sm text-muted-foreground">
              {state === 'RUNNING' ? 'Round 1 is planned when the first sending finishes, if any message failed for a reason that may pass.' : 'No round was needed.'}
            </p>
          )
        ) : null}
        {heldBack ? (
          <p className="px-6 text-sm">
            <span className="font-semibold" data-testid="held-back-count">
              {formatNumber(heldBack)}
            </span>{' '}
            {heldBack === 1 ? 'message was' : 'messages were'} held back by Meta&apos;s per-person marketing limit. Meta asks to wait at least 24 hours: retarget
            the Held back group from the report tomorrow.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
