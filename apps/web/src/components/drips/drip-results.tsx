'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { LEFT_REASON_LABEL, growthKeys, type ContactRow, type DripLeftReason, type DripResults, type StepMetric } from '@/lib/growth';
import { Can } from '@/lib/permissions';

const METRICS: Array<{ metric: StepMetric; label: string; key: keyof DripResults['steps'][number] }> = [
  { metric: 'SENT', label: 'Sent', key: 'sent' },
  { metric: 'DELIVERED', label: 'Delivered', key: 'delivered' },
  { metric: 'READ', label: 'Read', key: 'read' },
  { metric: 'CLICKED', label: 'Clicked', key: 'clicked' },
  { metric: 'REPLIED', label: 'Replied', key: 'replied' },
  { metric: 'FAILED', label: 'Failed', key: 'failed' },
  { metric: 'SKIPPED', label: 'Skipped', key: 'skipped' },
];
const PAGE_SIZE = 50;

/**
 * Drip results (feature 005 US6, FR-035, FR-036): contacts in it, finished and left by reason, each
 * step's counts, and the contacts behind any count with an export.
 */
export function DripResultsView({ dripId }: { dripId: string }) {
  const results = useQuery({ queryKey: growthKeys.dripResults(dripId), queryFn: () => api<DripResults>(`/drips/${dripId}/results`) });
  const [selected, setSelected] = useState<{ stepId: string; position: number; metric: StepMetric } | null>(null);
  const [page, setPage] = useState(1);
  const contacts = useQuery({
    queryKey: ['drips', 'detail', dripId, 'results', 'contacts', selected?.stepId, selected?.metric, page],
    queryFn: () => api<{ items: ContactRow[]; total: number }>(`/drips/${dripId}/results/contacts?stepId=${selected!.stepId}&metric=${selected!.metric}&page=${page}&pageSize=${PAGE_SIZE}`),
    enabled: Boolean(selected),
  });

  if (results.isLoading) return <p className="text-sm text-muted-foreground">Counting…</p>;
  if (results.error || !results.data) return <p className="text-sm text-destructive">{errorMessage(results.error)}</p>;
  const r = results.data;
  const leftTotal = Object.values(r.left).reduce((a, b) => a + (b ?? 0), 0);
  const pages = Math.max(1, Math.ceil((contacts.data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid grid-cols-3 gap-6 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">In it now</div>
            <div className="text-2xl font-semibold">{formatNumber(r.active)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Finished</div>
            <div className="text-2xl font-semibold">{formatNumber(r.finished)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Left</div>
            <div className="text-2xl font-semibold">{formatNumber(leftTotal)}</div>
            <div className="text-xs text-muted-foreground">
              {Object.entries(r.left)
                .map(([reason, n]) => `${LEFT_REASON_LABEL[reason as DripLeftReason] ?? reason}: ${formatNumber(n ?? 0)}`)
                .join(' · ')}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void results.refetch()}>
          Refresh results
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                {METRICS.map((m) => (
                  <TableHead key={m.metric} className="text-right">
                    {m.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.steps.map((s) => (
                <TableRow key={s.stepId} data-testid={s.removed ? `result-removed-step-${s.position}` : `result-step-${s.position}`}>
                  <TableCell>
                    <div className="font-medium">
                      Step {s.position}
                      {s.removed ? ' (removed)' : ''}
                    </div>
                    <div className="text-xs text-muted-foreground">{s.templateName}</div>
                  </TableCell>
                  {METRICS.map((m) => (
                    <TableCell key={m.metric} className="text-right">
                      <button
                        type="button"
                        className="underline-offset-2 hover:underline"
                        data-testid={`metric-${m.metric}`}
                        onClick={() => {
                          setSelected({ stepId: s.stepId, position: s.position, metric: m.metric });
                          setPage(1);
                        }}
                      >
                        {formatNumber(s[m.key] as number)}
                      </button>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">
              Step {selected.position}: {METRICS.find((m) => m.metric === selected.metric)?.label.toLowerCase()} ({formatNumber(contacts.data?.total ?? 0)})
            </CardTitle>
            <Can permission="data.export">
              <Button variant="outline" size="sm" asChild>
                <a href={`/api/drips/${dripId}/results/export?stepId=${selected.stepId}&metric=${selected.metric}`} download>
                  Export (CSV)
                </a>
              </Button>
            </Can>
          </CardHeader>
          <CardContent className="p-0">
            {contacts.data?.items.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contact</TableHead>
                    <TableHead>Phone</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contacts.data.items.map((c, i) => (
                    <TableRow key={c.id ?? `row-${i}`} data-testid="metric-contact-row">
                      <TableCell>{c.name ?? (c.id ? 'No name' : 'Deleted contact')}</TableCell>
                      <TableCell className="text-muted-foreground">{c.phone ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="p-6 text-sm text-muted-foreground">{contacts.isLoading ? 'Loading…' : 'Nobody here.'}</p>
            )}
            {pages > 1 ? (
              <div className="flex items-center gap-2 p-4 text-sm">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span>
                  Page {page} of {pages}
                </span>
                <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
