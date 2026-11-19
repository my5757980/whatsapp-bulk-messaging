'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import type { Paged } from '@/lib/types';

interface AuditEntry {
  id: string;
  actorType: 'USER' | 'API_KEY' | 'SYSTEM';
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** Audited actions (data-model.md §1). */
const ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'user.invited',
  'user.role_changed',
  'user.deactivated',
  'user.reactivated',
  'number.connected',
  'number.disconnected',
  'number.credentials_changed',
  'campaign.launched',
  'campaign.scheduled',
  'campaign.paused',
  'campaign.auto_paused',
  'campaign.resumed',
  'campaign.cancelled',
  'data.exported',
  'contact.deleted',
  'api_key.created',
  'api_key.revoked',
  'settings.updated',
  'rate_card.updated',
];
const PAGE_SIZE = 50;

/** Settings > Audit log (T179): admins only, filter by action and person. */
export default function AuditPage() {
  return (
    <RequirePermission permission="audit.view">
      <AuditLog />
    </RequirePermission>
  );
}

function AuditLog() {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<Array<{ id: string; name: string; email: string }>>('/users') });
  const entries = useQuery({
    queryKey: ['audit-logs', { action, actor, page }],
    queryFn: () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (action) qs.set('action', action);
      if (actor) qs.set('actorUserId', actor);
      return api<Paged<AuditEntry>>(`/audit-logs?${qs}`);
    },
  });
  const pages = Math.max(1, Math.ceil((entries.data?.page.total ?? 0) / PAGE_SIZE));

  return (
    <div className="grid max-w-6xl gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <label htmlFor="audit-action" className="text-sm font-medium">
            Action
          </label>
          <NativeSelect
            id="audit-action"
            className="w-56"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="audit-actor" className="text-sm font-medium">
            Person
          </label>
          <NativeSelect
            id="audit-actor"
            className="w-56"
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Everyone</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {entries.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : entries.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(entries.error)}</p>
          ) : !entries.data?.items.length ? (
            <p className="p-6 text-sm text-muted-foreground">No entries.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.data.items.map((e) => (
                  <TableRow key={e.id} data-testid="audit-row">
                    <TableCell className="whitespace-nowrap text-xs">{formatDateTime(e.createdAt)}</TableCell>
                    <TableCell className="text-sm">
                      {e.actorName ?? (e.actorType === 'SYSTEM' ? 'System' : 'API key')}
                      {e.ip ? <div className="text-xs text-muted-foreground">{e.ip}</div> : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="text-xs">
                      {e.targetType}
                      {e.targetId ? <div className="font-mono text-muted-foreground">{e.targetId.slice(0, 8)}…</div> : null}
                    </TableCell>
                    <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground" title={JSON.stringify(e.metadata)}>
                      {Object.keys(e.metadata).length ? JSON.stringify(e.metadata) : '—'}
                    </TableCell>
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
