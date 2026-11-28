'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AutomationEditor } from '@/components/automations/automation-editor';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import {
  AUTOMATION_STATUS_LABEL,
  AUTOMATION_STATUS_VARIANT,
  PAUSE_TEXT,
  SKIP_LABEL,
  automationKeys,
  type AutomationDay,
  type AutomationRecipient,
  type DateAutomation,
} from '@/lib/automations';
import { errorMessage, toastError } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { Can, usePermissions } from '@/lib/permissions';

/** One date automation (feature 010 US5): its settings, switch, results per day and the recipients of a day. */
export default function AutomationPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <Automation />
    </RequirePermission>
  );
}

const skippedTotal = (d: AutomationDay) => Object.values(d.skipped).reduce((sum, n) => sum + n, 0);
const skippedText = (d: AutomationDay) =>
  Object.entries(d.skipped)
    .map(([reason, n]) => `${n} ${SKIP_LABEL[reason] ?? reason}`)
    .join(', ');

function Automation() {
  const { id } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const editable = can('campaigns.manage');
  if (id === 'new') {
    return (
      <div className="grid max-w-3xl gap-6">
        <Link href="/automations" className="text-sm text-muted-foreground hover:underline">
          ← Automations
        </Link>
        <AutomationEditor editable={editable} />
      </div>
    );
  }
  return <ExistingAutomation id={id} editable={editable} />;
}

function ExistingAutomation({ id, editable }: { id: string; editable: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const automation = useQuery({ queryKey: automationKeys.one(id), queryFn: () => api<DateAutomation>(`/date-automations/${id}`) });
  const results = useQuery({ queryKey: automationKeys.results(id), queryFn: () => api<{ days: AutomationDay[] }>(`/date-automations/${id}/results`) });
  const [day, setDay] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: (on: boolean) => api<DateAutomation>(`/date-automations/${id}/switch`, { method: 'POST', json: { on } }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(automationKeys.one(id), saved);
      toast.success(saved.status === 'ON' ? 'Automation switched on' : 'Automation switched off');
      await queryClient.invalidateQueries({ queryKey: automationKeys.list });
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api(`/date-automations/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('Automation deleted');
      await queryClient.invalidateQueries({ queryKey: automationKeys.list });
      router.push('/automations');
    },
    onError: toastError,
  });

  if (automation.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!automation.data) return <p className="text-sm text-destructive">{errorMessage(automation.error)}</p>;
  const a = automation.data;

  return (
    <div className="grid max-w-5xl gap-6">
      <Link href="/automations" className="text-sm text-muted-foreground hover:underline">
        ← Automations
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{a.name}</h1>
          <span>
            <Badge variant={AUTOMATION_STATUS_VARIANT[a.status]} data-testid="automation-status">
              {AUTOMATION_STATUS_LABEL[a.status]}
            </Badge>
          </span>
          {a.status === 'PAUSED' && a.pausedReason ? <p className="text-sm text-destructive">{PAUSE_TEXT[a.pausedReason]}</p> : null}
        </div>
        <span className="flex gap-2">
          <Can permission="campaigns.launch">
            <Button onClick={() => toggle.mutate(a.status !== 'ON')} disabled={toggle.isPending}>
              {a.status === 'ON' ? 'Switch off' : a.status === 'PAUSED' ? 'Resume' : 'Switch on'}
            </Button>
          </Can>
          <Can permission="campaigns.manage">
            <Button variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Delete
            </Button>
          </Can>
        </span>
      </div>
      <AutomationEditor automation={a} editable={editable} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Results by day</CardTitle>
          <CardDescription>The last 30 days. Replied counts a message from the contact within 72 hours of delivery. Choose a day to see its contacts.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {results.data?.days.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Due</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Read</TableHead>
                  <TableHead className="text-right">Replied</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead>Skipped</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.data.days.map((d) => (
                  <TableRow key={d.date} data-testid="results-day">
                    <TableCell>
                      <button type="button" className="font-medium hover:underline" onClick={() => setDay(d.date)}>
                        {d.date}
                      </button>
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(d.due)}</TableCell>
                    <TableCell className="text-right" data-testid="results-sent">
                      {formatNumber(d.sent)}
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(d.delivered)}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.read)}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.replied)}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.failed)}</TableCell>
                    <TableCell className="text-muted-foreground">{skippedTotal(d) ? skippedText(d) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">{results.isLoading ? 'Loading…' : 'Nothing has been due yet.'}</p>
          )}
        </CardContent>
      </Card>
      {day ? <Recipients id={id} date={day} /> : null}
    </div>
  );
}

function Recipients({ id, date }: { id: string; date: string }) {
  const [page, setPage] = useState(1);
  const recipients = useQuery({
    queryKey: automationKeys.recipients(id, date, page),
    queryFn: () => api<{ total: number; items: AutomationRecipient[] }>(`/date-automations/${id}/recipients?date=${date}&page=${page}&pageSize=50`),
  });
  const total = recipients.data?.total ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Contacts due on {date}</CardTitle>
        <CardDescription>{formatNumber(total)} contacts</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 p-0 pb-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(recipients.data?.items ?? []).map((r) => (
              <TableRow key={r.contactId} data-testid="recipient-row">
                <TableCell>{r.name ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">{r.phone}</TableCell>
                <TableCell>
                  {r.status.charAt(0) + r.status.slice(1).toLowerCase()}
                  {r.reason ? <span className="text-muted-foreground"> ({SKIP_LABEL[r.reason] ?? r.reason})</span> : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.messageStatus ? r.messageStatus.charAt(0) + r.messageStatus.slice(1).toLowerCase() : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {total > 50 ? (
          <div className="flex items-center gap-2 px-4">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page} of {Math.ceil(total / 50)}
            </span>
            <Button variant="outline" size="sm" disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
