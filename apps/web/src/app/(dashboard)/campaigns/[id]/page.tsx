'use client';

import type { MessageStatus } from '@wbm/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CampaignControls, PausedBanner } from '@/components/campaigns/campaign-controls';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { campaignStateVariant, formatDateTime, formatNumber, messageStatusBadge, progressPercent, titleCase, totalRecipients } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import { formatInZone } from '@/lib/time';
import type { CampaignDetail, CampaignMessage, Paged, StatusTotals } from '@/lib/types';

const POLL_MS = 5_000;
const PAGE_SIZE = 50;

const TOTALS: Array<{ key: keyof StatusTotals | 'inQueue'; label: string }> = [
  { key: 'inQueue', label: 'Queued' },
  { key: 'sent', label: 'Sent' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'read', label: 'Read' },
  { key: 'failed', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'cancelled', label: 'Cancelled' },
];

const FILTERS: Array<{ value: '' | MessageStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING', label: 'Queued' },
  { value: 'SENT', label: 'Sent' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'READ', label: 'Read' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'SKIPPED', label: 'Skipped' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** Campaign detail with live totals and recipient statuses (T111). */
export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | MessageStatus>('');
  const [page, setPage] = useState(1);

  const campaign = useQuery({
    queryKey: queryKeys.campaign(id),
    queryFn: () => api<CampaignDetail>(`/campaigns/${id}`),
    refetchInterval: (q) => (q.state.data?.state === 'RUNNING' ? POLL_MS : false),
  });
  const running = campaign.data?.state === 'RUNNING';
  const messages = useQuery({
    queryKey: queryKeys.campaignMessages(id, { status, page }),
    queryFn: () => api<Paged<CampaignMessage>>(`/campaigns/${id}/messages?page=${page}&pageSize=${PAGE_SIZE}${status ? `&status=${status}` : ''}`),
    enabled: Boolean(campaign.data && campaign.data.state !== 'DRAFT'),
    refetchInterval: running ? POLL_MS : false,
  });

  if (campaign.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (campaign.error || !campaign.data) return <p className="text-sm text-destructive">{errorMessage(campaign.error)}</p>;
  const c = campaign.data;
  if (c.state === 'DRAFT') {
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold">{c.name}</h1>
        <p className="text-sm text-muted-foreground">This campaign is still a draft.</p>
        <div>
          <Button asChild>
            <Link href={`/campaigns/new?id=${c.id}&step=1`}>Continue editing</Link>
          </Button>
        </div>
      </div>
    );
  }

  const total = totalRecipients(c.totals);
  const percent = progressPercent(c.totals);
  const pages = Math.max(1, Math.ceil((messages.data?.page.total ?? 0) / PAGE_SIZE));
  const deleteContact = (m: CampaignMessage) =>
    api(`/contacts/${m.contactId}`, { method: 'DELETE' })
      .then(() => {
        toast.success('Contact data deleted');
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
          queryClient.invalidateQueries({ queryKey: queryKeys.campaign(id) }),
        ]);
      })
      .catch(toastError);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{c.name}</h1>
            <Badge variant={campaignStateVariant[c.state]} data-testid="campaign-state">
              {titleCase(c.state)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {c.templateName} · {c.numberLabel} · launched {formatDateTime(c.launchedAt)}
            {c.completedAt ? ` · completed ${formatDateTime(c.completedAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/campaigns/${c.id}/report`}>View report</Link>
          </Button>
          <CampaignControls campaign={c} />
        </div>
      </div>

      <PausedBanner campaign={c} />
      {c.state === 'SCHEDULED' && c.scheduledAt ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 p-4 text-sm" data-testid="scheduled-banner">
          <div>
            <div className="font-medium">
              Scheduled for {formatInZone(c.scheduledAt, c.timezone)} ({c.timezone})
            </div>
            <div className="text-muted-foreground">Recipients are selected when it starts.</div>
          </div>
          <Can permission="campaigns.launch">
            <ConfirmDialog
              trigger={<Button variant="outline">Unschedule</Button>}
              title="Move this campaign back to draft?"
              description="It will not start at the scheduled time. You can edit it and schedule or send it again."
              confirmLabel="Unschedule"
              onConfirm={() =>
                api(`/campaigns/${c.id}/unschedule`, { method: 'POST' })
                  .then(() => {
                    toast.success('Campaign moved back to draft');
                    return queryClient.invalidateQueries({ queryKey: queryKeys.campaign(c.id) });
                  })
                  .catch(toastError)
              }
            />
          </Can>
        </div>
      ) : null}

      <Card>
        <CardContent className="grid gap-4 p-5">
          <div className="flex items-center justify-between text-sm">
            <span>
              {formatNumber(total)} recipients · {percent}% processed
            </span>
            {running ? <span className="text-muted-foreground">Updating every 5 seconds</span> : null}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {TOTALS.map(({ key, label }) => (
              <div key={key} className="rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-xl font-semibold" data-testid={`total-${key}`}>
                  {formatNumber(key === 'inQueue' ? c.totals.pending + c.totals.queued : c.totals[key])}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Recipients</h2>
          <NativeSelect
            aria-label="Filter by status"
            className="w-48"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | MessageStatus);
              setPage(1);
            }}
          >
            {FILTERS.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Delivered</TableHead>
                  <TableHead>Read</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(messages.data?.items ?? []).map((m) => {
                  const badge = messageStatusBadge(m.status);
                  return (
                    <TableRow key={m.id} data-testid="recipient-row">
                      <TableCell>
                        <div className="font-medium">{m.contactName ?? (m.phone ? 'Unnamed contact' : 'Deleted contact')}</div>
                        <div className="text-xs text-muted-foreground">{m.phone ?? '—'}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xs text-xs">
                        {m.failureReason ?? (m.skipReason ? titleCase(m.skipReason) : '')}
                        {m.failureCode ? <span className="text-muted-foreground"> ({m.failureCode})</span> : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(m.sentAt)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(m.deliveredAt)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(m.readAt)}</TableCell>
                      <TableCell className="text-right">
                        {m.contactId ? (
                          <Can permission="contacts.delete">
                            <ConfirmDialog
                              trigger={
                                <Button variant="ghost" size="sm" className="text-destructive">
                                  Delete contact data
                                </Button>
                              }
                              title="Delete this contact's personal data?"
                              description="The contact, their consent history and uploaded details are removed. Campaign totals keep the delivery outcome without the phone number. This cannot be undone."
                              confirmLabel="Delete data"
                              confirmVariant="destructive"
                              onConfirm={() => deleteContact(m)}
                            />
                          </Can>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {messages.isSuccess && !messages.data.items.length ? <p className="p-6 text-sm text-muted-foreground">No recipients with this status.</p> : null}
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
    </div>
  );
}
