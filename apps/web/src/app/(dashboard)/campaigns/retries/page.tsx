'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ROUND_STATUS } from '@/components/campaigns/retry-rounds-panel';
import { RequirePermission } from '@/components/require-permission';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { growthKeys, type RetryRound, type RetryRoundStatus } from '@/lib/growth';

type Row = RetryRound & { campaign: { id: string; name: string } };

/** Retry rounds across campaigns (feature 005 US3, FR-016): upcoming by default, or by status. */
export default function RetryRoundsPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <RetryRoundsList />
    </RequirePermission>
  );
}

function RetryRoundsList() {
  const [status, setStatus] = useState<'' | RetryRoundStatus>('');
  const rounds = useQuery({
    queryKey: [...growthKeys.allRetryRounds, status],
    queryFn: () => api<Row[]>(`/retry-rounds${status ? `?status=${status}` : ''}`),
    refetchInterval: 15_000,
  });

  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <Link href="/campaigns" className="text-sm text-muted-foreground hover:underline">
          ← Campaigns
        </Link>
        <h1 className="text-2xl font-semibold">Retry rounds</h1>
        <p className="text-sm text-muted-foreground">Rounds that send failed campaign messages again. Cancel a round from its campaign.</p>
      </div>
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor="round-status">Status</Label>
        <NativeSelect id="round-status" value={status} onChange={(e) => setStatus(e.target.value as '' | RetryRoundStatus)}>
          <option value="">Coming up and sending</option>
          {(Object.keys(ROUND_STATUS) as RetryRoundStatus[]).map((s) => (
            <option key={s} value={s}>
              {ROUND_STATUS[s]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Card>
        <CardContent className="p-0">
          {rounds.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(rounds.error)}</p>
          ) : rounds.data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Round</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">To send again</TableHead>
                  <TableHead className="text-right">Recovered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rounds.data.map((r) => (
                  <TableRow key={`${r.campaign.id}-${r.round}`}>
                    <TableCell>
                      <Link href={`/campaigns/${r.campaign.id}`} className="hover:underline">
                        {r.campaign.name}
                      </Link>
                    </TableCell>
                    <TableCell>{r.round}</TableCell>
                    <TableCell>
                      {ROUND_STATUS[r.status]}
                      {r.note ? <span className="block text-xs text-muted-foreground">{r.note}</span> : null}
                    </TableCell>
                    <TableCell>{formatDateTime(r.startedAt ?? r.dueAt)}</TableCell>
                    <TableCell className="text-right">{formatNumber(r.recipients)}</TableCell>
                    <TableCell className="text-right">{formatNumber(r.recovered)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">{rounds.isLoading ? 'Loading…' : 'No rounds here.'}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
