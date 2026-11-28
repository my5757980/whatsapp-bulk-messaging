'use client';

import { useQuery } from '@tanstack/react-query';
import { REPORT_RANGE_WORDS, reportRangeProblem } from '@wbm/shared';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber, titleCase } from '@/lib/format';
import { Can } from '@/lib/permissions';

// Feature 009 (US5, FR-034 - FR-036): the overview, team member and opt-in reports for a range of days
// in the company time zone, each with a CSV download (data.export).

interface Counts {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  failed: number;
  expired: number;
  estimatedCostUsd: string;
}
interface Overview {
  from: string;
  to: string;
  totals: Counts;
  days: Array<Counts & { day: string }>;
  byCategory: Array<Counts & { category: string }>;
  byNumber: Array<Counts & { numberId: string; label: string }>;
  failedByReason: Array<{ code: number | null; reason: string; count: number }>;
}
interface Team {
  members: Array<{ userId: string; name: string; active: boolean; campaignsLaunched: number; campaignTotals: Counts; chatsTaken: number; chatsClosed: number; repliesSent: number; medianFirstResponseSeconds: number | null }>;
}
interface Consent {
  counts: Array<{ day: string; source: string; optedIn: number; optedOut: number }>;
  items: Array<{ contactId: string; name: string | null; phone: string; status: string; source: string; note: string | null; actor: string | null; at: string }>;
  total: number;
}

const COLUMNS: Array<[keyof Counts, string]> = [
  ['sent', 'Sent'],
  ['delivered', 'Delivered'],
  ['read', 'Read'],
  ['replied', 'Replied'],
  ['clicked', 'Clicked'],
  ['failed', 'Failed'],
  ['expired', 'Expired'],
];
const usd = (value: string) => `$${Number(value).toFixed(2)}`;
const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function CountsRow({ label, c }: { label: string; c: Counts }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      {COLUMNS.map(([key]) => (
        <TableCell key={key} className="text-right">
          {formatNumber(c[key] as number)}
        </TableCell>
      ))}
      <TableCell className="text-right">{usd(c.estimatedCostUsd)}</TableCell>
    </TableRow>
  );
}

function CountsTable({ title, rows, testId }: { title: string; rows: Array<{ label: string; c: Counts }>; testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                {COLUMNS.map(([key, label]) => (
                  <TableHead key={key} className="text-right">
                    {label}
                  </TableHead>
                ))}
                <TableHead className="text-right">Est. cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <CountsRow key={r.label} label={r.label} c={r.c} />
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">No campaign messages in these days.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Download({ report, range }: { report: 'overview' | 'team' | 'consent'; range: string }) {
  return (
    <Can permission="data.export">
      <a className="text-sm font-medium underline" href={`/api/reports/${report}.csv?${range}`} download data-testid={`download-${report}`}>
        Download CSV
      </a>
    </Can>
  );
}

function OverviewTab({ range }: { range: string }) {
  const q = useQuery({ queryKey: ['reports', 'overview', range], queryFn: () => api<Overview>(`/reports/overview?${range}`) });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error) return <p className="text-sm text-destructive">{errorMessage(q.error)}</p>;
  const o = q.data!;
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <Download report="overview" range={range} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="overview-totals">
        {[...COLUMNS.map(([key, label]) => [label, formatNumber(o.totals[key] as number)] as const), ['Est. cost', usd(o.totals.estimatedCostUsd)] as const].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="pt-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-2xl font-semibold" data-testid={`overview-${label.toLowerCase().replace(/\W+/g, '-')}`}>
                {value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <CountsTable title="By template category" testId="overview-categories" rows={o.byCategory.map((c) => ({ label: titleCase(c.category), c }))} />
      <CountsTable title="By number" testId="overview-numbers" rows={o.byNumber.map((n) => ({ label: n.label, c: n }))} />
      <CountsTable title="By day" testId="overview-days" rows={o.days.map((d) => ({ label: d.day, c: d }))} />
      {o.failedByReason.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Failures by reason</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            {o.failedByReason.map((f) => (
              <div key={`${f.code}-${f.reason}`} className="flex justify-between gap-4">
                <span>
                  {f.reason} {f.code ? <span className="text-muted-foreground">({f.code})</span> : null}
                </span>
                <span>{formatNumber(f.count)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function TeamTab({ range }: { range: string }) {
  const q = useQuery({ queryKey: ['reports', 'team', range], queryFn: () => api<Team>(`/reports/team?${range}`) });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error) return <p className="text-sm text-destructive">{errorMessage(q.error)}</p>;
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <Download report="team" range={range} />
      </div>
      <Card>
        <CardContent className="p-0">
          <Table data-testid="team-table">
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="text-right">Campaigns</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Replied</TableHead>
                <TableHead className="text-right">Chats taken</TableHead>
                <TableHead className="text-right">Chats closed</TableHead>
                <TableHead className="text-right">Replies sent</TableHead>
                <TableHead className="text-right">First response (median)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data!.members.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell>
                    {m.name} {m.active ? null : <span className="text-xs text-muted-foreground">(removed)</span>}
                  </TableCell>
                  <TableCell className="text-right">{formatNumber(m.campaignsLaunched)}</TableCell>
                  <TableCell className="text-right">{formatNumber(m.campaignTotals.sent)}</TableCell>
                  <TableCell className="text-right">{formatNumber(m.campaignTotals.replied)}</TableCell>
                  <TableCell className="text-right">{formatNumber(m.chatsTaken)}</TableCell>
                  <TableCell className="text-right">{formatNumber(m.chatsClosed)}</TableCell>
                  <TableCell className="text-right">{formatNumber(m.repliesSent)}</TableCell>
                  <TableCell className="text-right">{m.medianFirstResponseSeconds === null ? '—' : `${Math.round(m.medianFirstResponseSeconds)} s`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ConsentTab({ range }: { range: string }) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['reports', 'consent', range, page], queryFn: () => api<Consent>(`/reports/consent?${range}&page=${page}&pageSize=50`) });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error) return <p className="text-sm text-destructive">{errorMessage(q.error)}</p>;
  const c = q.data!;
  const bySource = new Map<string, { optedIn: number; optedOut: number }>();
  for (const row of c.counts) {
    const s = bySource.get(row.source) ?? { optedIn: 0, optedOut: 0 };
    bySource.set(row.source, { optedIn: s.optedIn + row.optedIn, optedOut: s.optedOut + row.optedOut });
  }
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <Download report="consent" range={range} />
      </div>
      <Card data-testid="consent-sources">
        <CardHeader>
          <CardTitle className="text-base">By source</CardTitle>
          <CardDescription>{formatNumber(c.total)} changes in these days.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {[...bySource.entries()].map(([source, s]) => (
            <div key={source} className="flex justify-between">
              <span>{titleCase(source)}</span>
              <span>
                {formatNumber(s.optedIn)} in · {formatNumber(s.optedOut)} out
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <Table data-testid="consent-table">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.items.map((i) => (
                <TableRow key={`${i.contactId}-${i.at}`}>
                  <TableCell>{formatDateTime(i.at)}</TableCell>
                  <TableCell>
                    {i.name ?? '—'} <span className="text-muted-foreground">{i.phone}</span>
                  </TableCell>
                  <TableCell>{i.status === 'OPTED_IN' ? 'Opted in' : i.status === 'OPTED_OUT' ? 'Opted out' : 'Unknown'}</TableCell>
                  <TableCell>
                    {titleCase(i.source)}
                    {i.note ? <span className="text-muted-foreground"> · {i.note}</span> : null}
                  </TableCell>
                  <TableCell>{i.actor ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {c.total > 50 ? (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" className="underline disabled:opacity-50" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {Math.ceil(c.total / 50)}
          </span>
          <button type="button" className="underline disabled:opacity-50" disabled={page * 50 >= c.total} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ReportsView() {
  const now = new Date();
  const [from, setFrom] = useState(isoDay(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(isoDay(now));
  const problem = reportRangeProblem(from, to, isoDay(now));
  const range = `from=${from}&to=${to}`;
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground">Campaign results, your team&apos;s work and opt-ins for the days you choose (company time zone).</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="report-from">From</Label>
          <Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="report-to">To</Label>
          <Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {problem ? (
          <p role="alert" className="text-sm text-destructive">
            {REPORT_RANGE_WORDS[problem]}
          </p>
        ) : null}
      </div>
      {problem ? null : (
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="consent">Opt-ins</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <OverviewTab range={range} />
          </TabsContent>
          <TabsContent value="team">
            <TeamTab range={range} />
          </TabsContent>
          <TabsContent value="consent">
            <ConsentTab range={range} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

export default function ReportsPage() {
  return (
    <RequirePermission permission="reports.view">
      <ReportsView />
    </RequirePermission>
  );
}
