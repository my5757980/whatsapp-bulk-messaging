'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import type { MediaCheckResult } from '@/lib/types';

const REASONS: Record<MediaCheckResult['problems'][number]['reason'], string> = {
  NOT_HTTPS: 'Not a secure https address',
  NOT_PUBLIC: 'Not a public address',
  UNREACHABLE: 'Could not be opened',
  WRONG_TYPE: 'Not the file type of the header',
  TOO_LARGE: 'Too large for WhatsApp',
  TIMEOUT: 'No answer within 5 seconds',
};

/**
 * Check media (feature 009 US4, FR-022): every distinct web address of the campaign is opened the way
 * launch does (a sample of 1,000 above that), and each problem is listed with its rows.
 */
export function MediaCheckCard({ campaignId }: { campaignId: string }) {
  const [result, setResult] = useState<MediaCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => api<MediaCheckResult>(`/campaigns/${campaignId}/media-check`, { method: 'POST' }),
    onSuccess: (r) => {
      setError(null);
      setResult(r);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <section aria-labelledby="media-check-title" className="grid gap-3 rounded-md border p-4" data-testid="media-check">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="media-check-title" className="text-sm font-medium">
            Media addresses
          </h3>
          <p className="text-xs text-muted-foreground">Launch checks every address; check them now to fix problems first.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? 'Checking…' : 'Check media'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="grid gap-2 text-sm" data-testid="media-check-result">
          <p className="text-muted-foreground">
            {formatNumber(result.checked)} address{result.checked === 1 ? '' : 'es'} checked{result.sampled ? ' (a random sample of 1,000)' : ''}.
          </p>
          {result.problems.length ? (
            <ul className="grid gap-1">
              {result.problems.map((p) => (
                <li key={p.url} className="rounded border border-destructive/40 p-2" data-testid="media-problem">
                  <div className="break-all font-mono text-xs">{p.url}</div>
                  <div className="text-xs text-destructive">
                    {REASONS[p.reason]}
                    {p.rows?.length ? ` · row${p.rows.length === 1 ? '' : 's'} ${p.rows.slice(0, 10).join(', ')}${p.rows.length > 10 ? '…' : ''}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-emerald-700">Every address works.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
