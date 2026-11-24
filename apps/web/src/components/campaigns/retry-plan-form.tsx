'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RETRY_DELAY_CHOICES, retryPlanProblem } from '@wbm/shared';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { growthKeys, type RetryPlan } from '@/lib/growth';

/** The default wait of each round when a member adds rounds. */
const DEFAULT_DELAYS = [30, 60, 120];

export function waitLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
}

/**
 * Retries of a draft or scheduled campaign (feature 005 US3, FR-013): up to 3 rounds that send
 * failures that may pass again. Saved as soon as it changes.
 */
export function RetryPlanForm({ campaignId }: { campaignId: string }) {
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: growthKeys.retryPlan(campaignId), queryFn: () => api<RetryPlan>(`/campaigns/${campaignId}/retry-plan`) });
  const [draft, setDraft] = useState<RetryPlan | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan.data && draft === null) setDraft(plan.data);
  }, [plan.data, draft]);

  const save = useMutation({
    mutationFn: (next: RetryPlan) => api<RetryPlan>(`/campaigns/${campaignId}/retry-plan`, { method: 'PUT', json: next }),
    onSuccess: (result) => {
      queryClient.setQueryData(growthKeys.retryPlan(campaignId), result);
      setSaved(true);
      setError(null);
    },
    onError: (e) => {
      setSaved(false);
      setError(errorMessage(e));
    },
  });

  const change = (next: RetryPlan) => {
    setDraft(next);
    setSaved(false);
    const problem = retryPlanProblem(next);
    if (problem === 'RETRY_WINDOW_EXCEEDED') setError('All rounds must start within 24 hours. Choose shorter waits.');
    else if (!problem) save.mutate(next);
  };

  if (!draft) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Retry failed messages</CardTitle>
        <CardDescription>
          Only failures that may pass are sent again: a temporary WhatsApp error or a sending limit. Invalid numbers, opt-outs and messages held back by
          Meta&apos;s per-person marketing limit are not retried. All rounds start within 24 hours of the campaign&apos;s start.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="retry-rounds">Retry rounds</Label>
          <NativeSelect
            id="retry-rounds"
            value={String(draft.rounds)}
            onChange={(e) => {
              const rounds = Number(e.target.value);
              change({ rounds, delaysMinutes: Array.from({ length: rounds }, (_, i) => draft.delaysMinutes[i] ?? DEFAULT_DELAYS[i] ?? 30) });
            }}
          >
            <option value="0">No retries</option>
            <option value="1">1 round</option>
            <option value="2">2 rounds</option>
            <option value="3">3 rounds</option>
          </NativeSelect>
        </div>
        {draft.delaysMinutes.map((delay, i) => (
          <div key={i} className="grid gap-1.5">
            <Label htmlFor={`retry-wait-${i + 1}`}>Round {i + 1} waits</Label>
            <NativeSelect
              id={`retry-wait-${i + 1}`}
              value={String(delay)}
              onChange={(e) => change({ ...draft, delaysMinutes: draft.delaysMinutes.map((d, j) => (j === i ? Number(e.target.value) : d)) })}
            >
              {RETRY_DELAY_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {waitLabel(choice)}
                </option>
              ))}
            </NativeSelect>
          </div>
        ))}
        <div className="text-xs sm:col-span-4">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : saved ? (
            <p className="text-muted-foreground" data-testid="retry-plan-saved">
              Retries saved.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
