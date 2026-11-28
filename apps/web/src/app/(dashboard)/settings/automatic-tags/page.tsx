'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LEAD_SOURCE_KINDS, LEAD_SOURCE_LABELS, type LeadSourceKind } from '@wbm/shared';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { contacts010Keys, type AutoTagRule } from '@/lib/contacts-010';
import { errorMessage, toastError } from '@/lib/errors';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Tag } from '@/lib/types';

// Feature 010 (US2, FR-010): tags added automatically when something happens.

const EVENTS: Array<{ value: AutoTagRule['event']; label: string }> = [
  { value: 'CONTACT_CREATED', label: 'A new contact comes from' },
  { value: 'CAMPAIGN_REPLY', label: 'A contact replies to a campaign' },
  { value: 'LINK_CLICK', label: 'A contact clicks a campaign link' },
  { value: 'OPTED_IN', label: 'A contact opts in' },
  { value: 'OPTED_OUT', label: 'A contact opts out' },
];
const eventText = (rule: AutoTagRule) => (rule.event === 'CONTACT_CREATED' ? `A new contact comes from ${LEAD_SOURCE_LABELS[rule.leadSource ?? 'UNKNOWN']}` : EVENTS.find((e) => e.value === rule.event)!.label);

export default function AutomaticTagsPage() {
  return (
    <RequirePermission permission="settings.view">
      <AutomaticTags />
    </RequirePermission>
  );
}

function AutomaticTags() {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: contacts010Keys.autoTagRules, queryFn: () => api<{ items: AutoTagRule[] }>('/auto-tag-rules') });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const [event, setEvent] = useState<AutoTagRule['event']>('CONTACT_CREATED');
  const [leadSource, setLeadSource] = useState<LeadSourceKind>('ORGANIC');
  const [tagId, setTagId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: contacts010Keys.autoTagRules });
  const add = useMutation({
    mutationFn: () => api<AutoTagRule>('/auto-tag-rules', { method: 'POST', json: { event, tagId, ...(event === 'CONTACT_CREATED' ? { leadSource } : {}) } }),
    onSuccess: async () => {
      setError(null);
      setTagId('');
      toast.success('Rule added');
      await refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (rule: AutoTagRule) => api<AutoTagRule>(`/auto-tag-rules/${rule.id}`, { method: 'PUT', json: { enabled: !rule.enabled } }),
    onSuccess: refresh,
    onError: toastError,
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/auto-tag-rules/${id}`, { method: 'DELETE' }), onSuccess: refresh, onError: toastError });

  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <h2 className="text-lg font-semibold">Automatic tags</h2>
        <p className="text-sm text-muted-foreground">Tags added when something happens. Rules apply from now on and never remove tags.</p>
      </div>
      <Can permission="settings.manage">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a rule</CardTitle>
            <CardDescription>When this happens, add the tag.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3 sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="rule-event">When</Label>
              <NativeSelect id="rule-event" value={event} onChange={(e) => setEvent(e.target.value as AutoTagRule['event'])}>
                {EVENTS.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {event === 'CONTACT_CREATED' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="rule-source">Lead source</Label>
                <NativeSelect id="rule-source" value={leadSource} onChange={(e) => setLeadSource(e.target.value as LeadSourceKind)}>
                  {LEAD_SOURCE_KINDS.filter((k) => k !== 'UNKNOWN').map((k) => (
                    <option key={k} value={k}>
                      {LEAD_SOURCE_LABELS[k]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : (
              <div />
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="rule-tag">Add the tag</Label>
              <NativeSelect id="rule-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
                <option value="">Choose a tag</option>
                {(tags.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="sm:col-span-3">
              <Button onClick={() => add.mutate()} disabled={!tagId || add.isPending}>
                Add rule
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-3">
                {error}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </Can>
      <Card>
        <CardContent className="grid gap-2 p-4 text-sm">
          {!rules.data?.items.length ? <p className="text-muted-foreground">No rules yet.</p> : null}
          {(rules.data?.items ?? []).map((rule) => (
            <div key={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2" data-testid="auto-tag-rule">
              <span>
                {eventText(rule)} → <strong>{rule.tagName}</strong> {rule.enabled ? null : <span className="text-muted-foreground">(off)</span>}
              </span>
              <Can permission="settings.manage">
                <span className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => toggle.mutate(rule)}>
                    {rule.enabled ? 'Switch off' : 'Switch on'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(rule.id)}>
                    Delete
                  </Button>
                </span>
              </Can>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
