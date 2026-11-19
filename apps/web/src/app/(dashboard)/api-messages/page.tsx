'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, messageStatusBadge } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import type { CampaignMessage, Paged } from '@/lib/types';

type ApiMessage = CampaignMessage & { templateName: string; templateLanguage: string; apiKeyId: string | null; apiKeyName: string | null; createdAt: string };

const PAGE_SIZE = 50;

/** Time of each status change, oldest first. */
function StatusTimeline({ message: m }: { message: ApiMessage }) {
  const steps: Array<[string, string | null]> = [
    ['Queued', m.createdAt],
    ['Sent', m.sentAt],
    ['Delivered', m.deliveredAt],
    ['Read', m.readAt],
    ['Failed', m.failedAt],
  ];
  return (
    <ol className="grid gap-0.5 text-xs text-muted-foreground">
      {steps
        .filter((s): s is [string, string] => s[1] !== null)
        .map(([label, at]) => (
          <li key={label} className="whitespace-nowrap">
            <span className="font-medium text-foreground">{label}</span> {formatDateTime(at)}
          </li>
        ))}
    </ol>
  );
}

/** Messages sent by other company systems through the public API (T193). */
export default function ApiMessagesPage() {
  const { can } = usePermissions();
  const [apiKeyId, setApiKeyId] = useState('');
  const [page, setPage] = useState(1);
  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api<Array<{ id: string; name: string; last4: string }>>('/api-keys'),
    enabled: can('apikeys.manage'),
  });
  const messages = useQuery({
    queryKey: ['api-messages', { apiKeyId, page }],
    queryFn: () => api<Paged<ApiMessage>>(`/api-messages?page=${page}&pageSize=${PAGE_SIZE}${apiKeyId ? `&apiKeyId=${apiKeyId}` : ''}`),
    refetchInterval: 15_000,
  });
  const pages = Math.max(1, Math.ceil((messages.data?.page.total ?? 0) / PAGE_SIZE));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">API messages</h1>
          <p className="text-sm text-muted-foreground">Template messages requested by your other systems with an API key.</p>
        </div>
        {keys.data?.length ? (
          <NativeSelect
            aria-label="Filter by API key"
            className="w-56"
            value={apiKeyId}
            onChange={(e) => {
              setApiKeyId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All keys</option>
            {keys.data.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} (••••{k.last4})
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </div>
      <Card>
        <CardContent className="p-0">
          {messages.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : messages.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(messages.error)}</p>
          ) : !messages.data?.items.length ? (
            <p className="p-6 text-sm text-muted-foreground">No API messages yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Timeline</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {messages.data.items.map((m) => {
                  const badge = messageStatusBadge(m.status);
                  return (
                    <TableRow key={m.id} data-testid="api-message-row">
                      <TableCell>
                        <div className="text-sm">{m.contactName ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">{m.phone ?? 'deleted'}</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {m.templateName} <span className="text-xs text-muted-foreground">{m.templateLanguage}</span>
                      </TableCell>
                      <TableCell className="text-sm">{m.apiKeyName ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                      <TableCell>
                        <StatusTimeline message={m} />
                      </TableCell>
                      <TableCell className="max-w-xs text-xs">{m.failureReason ?? m.skipReason ?? ''}</TableCell>
                    </TableRow>
                  );
                })}
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
