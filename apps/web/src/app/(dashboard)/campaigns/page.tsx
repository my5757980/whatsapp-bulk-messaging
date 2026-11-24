'use client';

import type { CampaignState } from '@wbm/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { campaignStateVariant, formatDateTime, formatNumber, titleCase, totalRecipients } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Campaign, Paged } from '@/lib/types';

const PAGE_SIZE = 20;
const STATES: Array<'' | CampaignState> = ['', 'DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'];

/** Campaigns list (T113). */
export default function CampaignsPage() {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<'' | CampaignState>('');
  const campaigns = useQuery({
    queryKey: queryKeys.campaigns({ page, state }),
    queryFn: () => api<Paged<Campaign>>(`/campaigns?page=${page}&pageSize=${PAGE_SIZE}${state ? `&state=${state}` : ''}`),
    refetchInterval: (q) => (q.state.data?.items.some((c) => c.state === 'RUNNING') ? 10_000 : false),
  });
  const pages = Math.max(1, Math.ceil((campaigns.data?.page.total ?? 0) / PAGE_SIZE));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Campaigns</h1>
          <p className="text-sm text-muted-foreground">Broadcasts sent with approved templates to opted-in contacts.</p>
        </div>
        <div className="flex gap-2">
          <NativeSelect
            aria-label="Filter by state"
            className="w-40"
            value={state}
            onChange={(e) => {
              setState(e.target.value as '' | CampaignState);
              setPage(1);
            }}
          >
            {STATES.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? titleCase(s) : 'All states'}
              </option>
            ))}
          </NativeSelect>
          <Button variant="outline" asChild>
            <Link href="/campaigns/retries">Retry rounds</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/campaigns/api">API campaigns</Link>
          </Button>
          <Can permission="campaigns.manage">
            <Button asChild>
              <Link href="/campaigns/new">New campaign</Link>
            </Button>
          </Can>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {campaigns.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : campaigns.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(campaigns.error)}</p>
          ) : !campaigns.data?.items.length ? (
            <p className="p-6 text-sm text-muted-foreground">No campaigns yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Recipients</TableHead>
                  <TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Read</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.data.items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={c.state === 'DRAFT' ? `/campaigns/new?id=${c.id}&step=1` : `/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {c.templateName ?? 'No template'} · {c.numberLabel ?? 'No number'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={campaignStateVariant[c.state]}>{titleCase(c.state)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(totalRecipients(c.totals))}</TableCell>
                    <TableCell className="text-right">{formatNumber(c.totals.delivered + c.totals.read)}</TableCell>
                    <TableCell className="text-right">{formatNumber(c.totals.read)}</TableCell>
                    <TableCell className="text-right">{formatNumber(c.totals.failed)}</TableCell>
                    <TableCell>{c.createdByName ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-end gap-2 text-sm">
        <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
          Previous
        </Button>
        <span>
          Page {page} of {pages}
        </span>
        <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= pages}>
          Next
        </Button>
      </div>
    </div>
  );
}
