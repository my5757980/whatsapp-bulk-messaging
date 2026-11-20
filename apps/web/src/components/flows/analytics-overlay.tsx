'use client';

import { useQuery } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';

export type AnalyticsPeriod = 'today' | '7d' | '30d';

export interface StepStats {
  entered: number;
  continued: number;
  dropped: number;
  options: Array<{ key: string; count: number }>;
}

interface FlowAnalytics {
  period: string;
  from: string;
  to: string;
  totals: Record<'started' | 'completed' | 'handedOver' | 'timedOut' | 'stoppedByMember' | 'optedOut' | 'interrupted' | 'failed' | 'other' | 'running', number>;
  steps: Array<StepStats & { stepId: string }>;
}

const TOTALS: Array<[keyof FlowAnalytics['totals'], string]> = [
  ['started', 'Started'],
  ['completed', 'Completed'],
  ['handedOver', 'Handed over'],
  ['timedOut', 'Timed out'],
  ['stoppedByMember', 'Stopped by a member'],
  ['optedOut', 'Opted out'],
  ['interrupted', 'Interrupted'],
  ['failed', 'Failed'],
  ['other', 'Other endings'],
  ['running', 'Still running'],
];

/** Analytics of the published version for a period (003 T077, FR-035), with stats per step. */
export function useFlowAnalytics(flowId: string, period: AnalyticsPeriod, enabled: boolean) {
  const query = useQuery({
    queryKey: ['flows', 'analytics', flowId, period],
    queryFn: () => api<FlowAnalytics>(`/flows/${flowId}/analytics?period=${period}`),
    enabled,
  });
  const stats = new Map((query.data?.steps ?? []).map((s) => [s.stepId, s]));
  return { data: query.data, stats, isLoading: query.isLoading };
}

/** The totals bar shown above the canvas in analytics mode; test runs are not counted. */
export function AnalyticsBar({ period, onPeriod, data, loading }: { period: AnalyticsPeriod; onPeriod: (period: AnalyticsPeriod) => void; data: FlowAnalytics | undefined; loading: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm" data-testid="analytics-totals">
      <div className="flex items-center gap-2">
        <Label htmlFor="analytics-period" className="text-xs">
          Period
        </Label>
        <NativeSelect id="analytics-period" className="h-8 w-auto" value={period} onChange={(e) => onPeriod(e.target.value as AnalyticsPeriod)}>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </NativeSelect>
      </div>
      {loading && <span className="text-muted-foreground">Loading…</span>}
      {data &&
        TOTALS.filter(([key]) => key === 'started' || data.totals[key] > 0).map(([key, label]) => (
          <span key={key}>
            <span className="text-muted-foreground">{label}</span> <span className="font-semibold">{data.totals[key]}</span>
          </span>
        ))}
      <span className="text-xs text-muted-foreground">Published version only; test runs are not counted.</span>
    </div>
  );
}
