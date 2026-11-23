'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DripEnrolments } from '@/components/drips/drip-enrolments';
import { DripResultsView } from '@/components/drips/drip-results';
import { DripSettingsForm } from '@/components/drips/drip-settings-form';
import { DripStepsEditor } from '@/components/drips/drip-steps-editor';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toaster';
import { ApiError, api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { DRIP_STATUS_LABEL, DRIP_STATUS_VARIANT, growthKeys, type DripDetail, type DripProblem } from '@/lib/growth';
import { Can, usePermissions } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { WhatsAppNumber } from '@/lib/types';

const PAUSED_REASON: Record<string, string> = {
  TEMPLATE_UNAVAILABLE: 'It paused itself: a step template is paused, disabled or not approved.',
  NUMBER_DISCONNECTED: 'It paused itself: its WhatsApp number is disconnected or sending is turned off.',
};

/** One drip: its steps, settings and contacts, and activating, pausing and archiving it (feature 005 US4). */
export default function DripPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <DripEditor />
    </RequirePermission>
  );
}

function DripEditor() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const drip = useQuery({ queryKey: growthKeys.drip(id), queryFn: () => api<DripDetail>(`/drips/${id}`) });
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const [tab, setTab] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  if (drip.isLoading) return <p className="text-sm text-muted-foreground">Loading drip…</p>;
  if (drip.error || !drip.data) return <p className="text-sm text-destructive">{errorMessage(drip.error)}</p>;
  const d = drip.data;
  const editable = d.status !== 'ARCHIVED' && permissions.can('campaigns.manage');
  const live = d.status === 'ACTIVE' || d.status === 'PAUSED';
  const wabaId = numbers.data?.find((n) => n.id === d.number.id)?.wabaId ?? null;

  const act = (action: 'activate' | 'pause' | 'archive', done: string) =>
    api<DripDetail>(`/drips/${id}/${action}`, { method: 'POST' })
      .then((updated) => {
        queryClient.setQueryData(growthKeys.drip(id), updated);
        if (action === 'activate') setTab('contacts');
        void queryClient.invalidateQueries({ queryKey: growthKeys.drips });
        toast.success(done);
      })
      .catch((e: unknown) => {
        const problems = e instanceof ApiError ? ((e.extra?.problems as DripProblem[] | undefined) ?? []) : [];
        if (problems.length) toast.error(`Fix these first: ${problems.map((p) => (p.stepPosition ? `step ${p.stepPosition}: ${p.message}` : p.message)).join('; ')}`);
        else toastError(e);
      });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/drips" className="text-sm text-muted-foreground hover:underline">
            ← Drips
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{d.name}</h1>
            <Badge variant={DRIP_STATUS_VARIANT[d.status]} data-testid="drip-status">
              {DRIP_STATUS_LABEL[d.status]}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            From {d.number.label} · {formatNumber(d.active)} in it now · {formatNumber(d.finished)} finished · {formatNumber(d.left)} left
          </p>
          {d.status === 'PAUSED' && d.pausedReason ? <p className="mt-1 text-sm text-amber-700">{PAUSED_REASON[d.pausedReason] ?? d.pausedReason}</p> : null}
        </div>
        <Can permission="campaigns.launch">
          <div className="flex flex-wrap gap-2">
            {d.status === 'DRAFT' || d.status === 'PAUSED' ? <Button onClick={() => act('activate', d.status === 'DRAFT' ? 'Drip activated' : 'Drip resumed')}>{d.status === 'DRAFT' ? 'Activate' : 'Resume'}</Button> : null}
            {d.status === 'ACTIVE' ? (
              <Button
                onClick={() => {
                  setTab('contacts');
                  setEnrolling(true);
                }}
              >
                Enrol contacts
              </Button>
            ) : null}
            {d.status === 'ACTIVE' ? (
              <Button variant="outline" onClick={() => act('pause', 'Drip paused')}>
                Pause
              </Button>
            ) : null}
            {d.status !== 'ARCHIVED' ? (
              <ConfirmDialog
                trigger={<Button variant="outline">Archive</Button>}
                title="Archive this drip?"
                description="Everyone in it leaves and gets no further steps. An archived drip cannot be changed or activated again."
                confirmLabel="Archive"
                onConfirm={() => act('archive', 'Drip archived')}
              />
            ) : null}
          </div>
        </Can>
      </div>

      {d.problems.length && d.status !== 'ARCHIVED' ? (
        <div role="status" className="rounded-md border bg-muted/40 p-4 text-sm" data-testid="drip-problems">
          <div className="font-medium">Before it can run:</div>
          <ul className="ml-5 list-disc">
            {d.problems.map((p, i) => (
              <li key={i}>{p.stepPosition ? `Step ${p.stepPosition}: ${p.message}` : p.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Tabs value={tab ?? (live ? 'contacts' : 'steps')} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="steps">Steps</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
        </TabsList>
        <TabsContent value="steps">
          <DripStepsEditor drip={d} wabaId={wabaId} editable={editable} />
        </TabsContent>
        <TabsContent value="settings">
          <DripSettingsForm drip={d} editable={editable} />
        </TabsContent>
        <TabsContent value="results">
          <DripResultsView dripId={d.id} />
        </TabsContent>
        <TabsContent value="contacts">
          <DripEnrolments dripId={d.id} active={d.status === 'ACTIVE'} enrolling={enrolling} onEnrollingChange={setEnrolling} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
