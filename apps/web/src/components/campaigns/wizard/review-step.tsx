'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RetryPlanForm } from '@/components/campaigns/retry-plan-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import { formatInZone, isValidTimeZone, toZonedInputValue, zonedTimeToUtc } from '@/lib/time';
import type { Campaign, CampaignDetail, CompanySettings, Estimate } from '@/lib/types';
import { paymentConfigSummary } from './payment-config';

const EXCLUDED_LABELS: Array<[keyof Estimate['excluded'], string]> = [
  ['optedOut', 'Opted out'],
  ['noOptIn', 'No opt-in (marketing template)'],
  ['invalidNumber', 'Invalid phone number'],
  ['duplicate', 'Duplicate in the file'],
  ['missingVariable', 'Missing variable value'],
  ['paymentAmountMissing', 'No amount to ask for'],
];

/** Step 4 (T110, T151): eligible and excluded counts, previews, then send now or schedule. */
export function ReviewStep({ campaign, onBack, onLaunched }: { campaign: CampaignDetail; onBack: () => void; onLaunched: (c: Campaign) => void }) {
  const estimate = useQuery({
    queryKey: ['campaign', campaign.id, 'estimate'],
    queryFn: () => api<Estimate>(`/campaigns/${campaign.id}/estimate`, { method: 'POST' }),
    staleTime: 0,
  });
  const settings = useQuery({ queryKey: queryKeys.settings, queryFn: () => api<CompanySettings>('/settings') });
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [when, setWhen] = useState('');
  const [zone, setZone] = useState<string | null>(null);
  const timeZone = zone ?? settings.data?.defaultTimezone ?? 'UTC';
  const zoneOk = isValidTimeZone(timeZone);
  const scheduledAt = mode === 'later' && when && zoneOk ? zonedTimeToUtc(when, timeZone) : null;
  const scheduleProblem =
    mode !== 'later' ? null : !zoneOk ? 'Unknown timezone' : !when ? 'Choose a date and time' : scheduledAt && scheduledAt.getTime() <= Date.now() ? 'Choose a time in the future' : null;

  const launch = useMutation({
    mutationFn: () =>
      api<Campaign>(`/campaigns/${campaign.id}/launch`, {
        method: 'POST',
        json: mode === 'later' && scheduledAt ? { scheduledAt: scheduledAt.toISOString(), timezone: timeZone } : {},
      }),
    onSuccess: onLaunched,
    onError: toastError,
  });

  if (estimate.isLoading) return <p className="text-sm text-muted-foreground">Checking recipients…</p>;
  if (estimate.error) {
    return (
      <div className="grid gap-4">
        <p className="text-sm text-destructive">{errorMessage(estimate.error)}</p>
        <div>
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    );
  }
  const e = estimate.data as Estimate;
  const excludedTotal = Object.values(e.excluded).reduce((a, b) => a + b, 0);

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Will receive the message</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold" data-testid="eligible-count">
              {formatNumber(e.eligible)}
            </div>
            <p className="text-sm text-muted-foreground">
              {campaign.numberLabel} · {campaign.templateName}
            </p>
            {campaign.paymentConfig ? (
              <p className="mt-2 text-sm" data-testid="payment-summary">
                {paymentConfigSummary(campaign.paymentConfig)}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Excluded ({formatNumber(excludedTotal)})</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            {EXCLUDED_LABELS.map(([key, label]) => (
              <div key={key} className="flex justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span>{formatNumber(e.excluded[key])}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      {e.estimatedCostUsd !== undefined ? (
        <p className="text-sm" data-testid="cost-estimate">
          Estimated cost:{' '}
          <span className="font-semibold">{new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(e.estimatedCostUsd)}</span>{' '}
          <span className="text-muted-foreground">(estimate from your rate card)</span>
          {e.uncostedRecipients ? <span className="text-muted-foreground"> · {formatNumber(e.uncostedRecipients)} recipients have no rate for their country</span> : null}
        </p>
      ) : null}
      {e.messagingLimitWarning ? (
        <p role="alert" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
          {e.messagingLimitWarning}
        </p>
      ) : null}
      <div className="grid gap-2">
        <div className="text-sm font-medium">Message preview</div>
        {e.previews.map((p) => (
          <div key={p.phoneMasked} className="rounded-md border p-3 text-sm">
            <div className="text-xs text-muted-foreground">{p.phoneMasked}</div>
            <div className="whitespace-pre-wrap">{p.text}</div>
          </div>
        ))}
      </div>
      <RetryPlanForm campaignId={campaign.id} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">When to send</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="send-mode" checked={mode === 'now'} onChange={() => setMode('now')} /> Send now
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="send-mode"
              checked={mode === 'later'}
              onChange={() => {
                setMode('later');
                if (!when) setWhen(toZonedInputValue(new Date(Date.now() + 60 * 60_000), timeZone));
              }}
            />{' '}
            Schedule for later
          </label>
          {mode === 'later' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="schedule-at">Date and time</Label>
                <Input id="schedule-at" type="datetime-local" value={when} onChange={(ev) => setWhen(ev.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="schedule-zone">Timezone</Label>
                <Input id="schedule-zone" value={timeZone} onChange={(ev) => setZone(ev.target.value)} placeholder="Asia/Dubai" />
              </div>
              {scheduleProblem ? (
                <p className="text-xs text-destructive sm:col-span-2">{scheduleProblem}</p>
              ) : scheduledAt ? (
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Starts {formatInZone(scheduledAt, timeZone)} ({timeZone}). Recipients are selected at that time.
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Can permission="campaigns.launch" fallback={<p className="text-sm text-muted-foreground">Your role cannot launch campaigns.</p>}>
          <ConfirmDialog
            trigger={<Button disabled={!e.eligible || launch.isPending || Boolean(scheduleProblem)}>{mode === 'later' ? 'Schedule' : 'Send now'}</Button>}
            title={mode === 'later' && scheduledAt ? `Schedule for ${formatInZone(scheduledAt, timeZone)}?` : `Send to ${formatNumber(e.eligible)} recipients?`}
            description={
              mode === 'later'
                ? 'The campaign starts automatically at that time. You can move it back to draft or cancel it before then.'
                : 'Sending starts right away. You can pause or cancel the campaign while it runs.'
            }
            confirmLabel={mode === 'later' ? 'Schedule' : 'Send now'}
            onConfirm={() => launch.mutateAsync().catch(() => undefined)}
          />
        </Can>
      </div>
    </div>
  );
}
