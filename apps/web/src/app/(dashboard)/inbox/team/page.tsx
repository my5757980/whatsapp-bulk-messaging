'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';

type Period = 'today' | '7d' | '30d';

interface TeamMetrics {
  period: Period;
  live: { ACTIVE: number; REQUESTING: number; INTERVENED: number };
  oldestRequestingSince: string | null;
  members: Array<{
    user: { id: string; name: string };
    intervened: number;
    resolved: number;
    medianFirstResponseSeconds: number | null;
    medianResolutionSeconds: number | null;
  }>;
}

const PERIODS: Array<[Period, string]> = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
];

/** "45s", "12m 5s" or "3h 20m". */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Team view (T095, FR-039): live chats by state and per-member figures for a period. */
export default function TeamViewPage() {
  return (
    <RequirePermission permission="inbox.metrics">
      <TeamView />
    </RequirePermission>
  );
}

function TeamView() {
  const [period, setPeriod] = useState<Period>('today');
  const metrics = useQuery({
    queryKey: ['inbox', 'team-metrics', period],
    queryFn: () => api<TeamMetrics>(`/inbox/team-metrics?period=${period}`),
    refetchInterval: 30_000,
  });
  const m = metrics.data;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Team view</h1>
          <Link href="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
            ← Live chat
          </Link>
        </div>
        <label className="flex items-center gap-2 text-sm">
          Period
          <NativeSelect aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>

      {!m ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Open" value={String(m.live.ACTIVE)} />
            <Stat label="Waiting for agent" value={String(m.live.REQUESTING)} />
            <Stat label="Taken" value={String(m.live.INTERVENED)} />
            <Stat
              label="Waiting since"
              value={m.oldestRequestingSince ? new Date(m.oldestRequestingSince).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Nobody waiting'}
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Members</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Members">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Member</th>
                    <th className="py-2 pr-4 font-medium">Chats taken</th>
                    <th className="py-2 pr-4 font-medium">Chats closed</th>
                    <th className="py-2 pr-4 font-medium">Median first response</th>
                    <th className="py-2 font-medium">Median resolution</th>
                  </tr>
                </thead>
                <tbody>
                  {m.members.map((row) => (
                    <tr key={row.user.id} className="border-t" data-testid="team-member-row">
                      <td className="py-2 pr-4">{row.user.name}</td>
                      <td className="py-2 pr-4" data-testid="team-intervened">
                        {row.intervened}
                      </td>
                      <td className="py-2 pr-4" data-testid="team-resolved">
                        {row.resolved}
                      </td>
                      <td className="py-2 pr-4">{formatDuration(row.medianFirstResponseSeconds)}</td>
                      <td className="py-2">{formatDuration(row.medianResolutionSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            First response runs from the customer&apos;s first message of a conversation to the first reply by a person; resolution runs from
            taking the chat to closing it. Chats closed automatically count for nobody. Periods follow the company time zone.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="grid gap-1 p-4">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xl font-semibold">{value}</span>
      </CardContent>
    </Card>
  );
}
