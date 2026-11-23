'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { growthKeys, type DripDetail, type DripTrigger, type DripTriggerKind } from '@/lib/growth';
import { queryKeys } from '@/lib/query';
import type { Campaign, Tag } from '@/lib/types';
import { NativeSelect } from '@/components/ui/native-select';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Starting events (feature 005 US5, FR-024), in our own words. */
const TRIGGER_KINDS: Array<{ kind: DripTriggerKind; label: string }> = [
  { kind: 'TAG_ADDED', label: 'A tag is added' },
  { kind: 'OPTED_IN', label: 'They opt in' },
  { kind: 'IMPORTED', label: 'An import adds them' },
  { kind: 'API_CREATED', label: 'The API adds them' },
  { kind: 'LINK_CLICKED', label: 'They open a campaign link' },
];

/**
 * Quiet hours, leaving rules and joining again (feature 005 US4, FR-021, FR-026, FR-028). Opting out,
 * being blocked or deleted, and removal by a member always end a drip; these are the rules a manager
 * chooses.
 */
export function DripSettingsForm({ drip, editable }: { drip: DripDetail; editable: boolean }) {
  const queryClient = useQueryClient();
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const [quiet, setQuiet] = useState(drip.quietHours ?? { from: '21:00', to: '09:00', days: [1, 2, 3, 4, 5, 6, 7] });
  const [quietOn, setQuietOn] = useState(drip.quietHours !== null);
  const [leaveOnReply, setLeaveOnReply] = useState(drip.leaveOnReply);
  const [leaveOnClick, setLeaveOnClick] = useState(drip.leaveOnClick);
  const [allowRejoin, setAllowRejoin] = useState(drip.allowRejoin);
  const [stopTagIds, setStopTagIds] = useState<string[]>(drip.stopTagIds);
  const [triggers, setTriggers] = useState<DripTrigger[]>(drip.triggers);
  const campaigns = useQuery({ queryKey: ['campaigns', 'for-triggers'], queryFn: () => api<{ items: Campaign[] }>('/campaigns?pageSize=100') });
  const setTrigger = (i: number, patch: Partial<DripTrigger>) => setTriggers((all) => all.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const triggersReady = triggers.every((t) => t.kind !== 'TAG_ADDED' || Boolean(t.tagId));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<DripDetail>(`/drips/${drip.id}`, {
        method: 'PATCH',
        json: {
          quietHours: quietOn ? quiet : null,
          leaveOnReply,
          leaveOnClick,
          allowRejoin,
          stopTagIds,
          triggers: triggers.map((t) => ({ kind: t.kind, tagId: t.kind === 'TAG_ADDED' ? (t.tagId ?? null) : null, campaignId: t.kind === 'LINK_CLICKED' ? (t.campaignId ?? null) : null })),
        },
      }),
    onSuccess: async () => {
      setMessage({ ok: true, text: 'Settings saved' });
      await queryClient.invalidateQueries({ queryKey: growthKeys.drip(drip.id) });
    },
    onError: (e) => setMessage({ ok: false, text: errorMessage(e) }),
  });

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Starting events</CardTitle>
          <CardDescription>
            Contacts join by themselves when one of these happens while the drip is active. You can also enrol contacts by hand.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {triggers.map((t, i) => (
            <div key={i} className="grid items-end gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]" data-testid={`trigger-${i + 1}`}>
              <div className="grid gap-1.5">
                <Label htmlFor={`trigger-${i}-kind`}>Starts when</Label>
                <NativeSelect id={`trigger-${i}-kind`} value={t.kind} disabled={!editable} onChange={(e) => setTrigger(i, { kind: e.target.value as DripTriggerKind, tagId: null, campaignId: null })}>
                  {TRIGGER_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {t.kind === 'TAG_ADDED' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={`trigger-${i}-tag`}>Tag</Label>
                  <NativeSelect id={`trigger-${i}-tag`} value={t.tagId ?? ''} disabled={!editable} onChange={(e) => setTrigger(i, { tagId: e.target.value || null })}>
                    <option value="">Choose a tag…</option>
                    {(tags.data ?? []).map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : t.kind === 'LINK_CLICKED' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={`trigger-${i}-campaign`}>Campaign</Label>
                  <NativeSelect id={`trigger-${i}-campaign`} value={t.campaignId ?? ''} disabled={!editable} onChange={(e) => setTrigger(i, { campaignId: e.target.value || null })}>
                    <option value="">Any campaign</option>
                    {(campaigns.data?.items ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <div />
              )}
              {editable ? (
                <Button variant="ghost" size="sm" onClick={() => setTriggers((all) => all.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
          {!triggers.length ? <p className="text-muted-foreground">No starting events: contacts join only when enrolled by hand.</p> : null}
          {editable ? (
            <div>
              <Button variant="outline" size="sm" disabled={triggers.length >= 10} onClick={() => setTriggers((all) => [...all, { kind: 'TAG_ADDED', tagId: null, campaignId: null }])}>
                Add starting event
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quiet hours</CardTitle>
          <CardDescription>Steps that fall due in quiet hours wait until they end, in their order. Times are in the company time zone.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={quietOn} disabled={!editable} onChange={(e) => setQuietOn(e.target.checked)} /> Use quiet hours
          </label>
          {quietOn ? (
            <div className="grid gap-3 sm:grid-cols-[8rem_8rem_1fr]">
              <div className="grid gap-1.5">
                <Label htmlFor="quiet-from">From</Label>
                <Input id="quiet-from" type="time" value={quiet.from} disabled={!editable} onChange={(e) => setQuiet({ ...quiet, from: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="quiet-to">Until</Label>
                <Input id="quiet-to" type="time" value={quiet.to} disabled={!editable} onChange={(e) => setQuiet({ ...quiet, to: e.target.value })} />
              </div>
              <fieldset className="grid gap-1.5">
                <legend className="text-sm font-medium">On these days</legend>
                <div className="flex flex-wrap gap-3">
                  {DAYS.map((day, i) => (
                    <label key={day} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={quiet.days.includes(i + 1)}
                        disabled={!editable}
                        onChange={(e) => setQuiet({ ...quiet, days: e.target.checked ? [...quiet.days, i + 1].sort() : quiet.days.filter((d) => d !== i + 1) })}
                      />
                      {day}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Leaving and joining again</CardTitle>
          <CardDescription>Opting out, being blocked or deleted, and removal by a member always end the drip for a contact.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={leaveOnReply} disabled={!editable} onChange={(e) => setLeaveOnReply(e.target.checked)} /> Leave when they write to this number
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={leaveOnClick} disabled={!editable} onChange={(e) => setLeaveOnClick(e.target.checked)} /> Leave when they open a tracked link of
            this drip
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={allowRejoin} disabled={!editable} onChange={(e) => setAllowRejoin(e.target.checked)} /> Contacts may join again after finishing or
            leaving
          </label>
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">Stop tags: leave when one of these tags is added</legend>
            <div className="flex flex-wrap gap-3">
              {(tags.data ?? []).map((tag) => (
                <label key={tag.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={stopTagIds.includes(tag.id)}
                    disabled={!editable}
                    onChange={(e) => setStopTagIds(e.target.checked ? [...stopTagIds, tag.id] : stopTagIds.filter((id) => id !== tag.id))}
                  />
                  {tag.name}
                </label>
              ))}
              {tags.data && !tags.data.length ? <span className="text-muted-foreground">No tags yet.</span> : null}
            </div>
          </fieldset>
        </CardContent>
      </Card>
      {editable ? (
        <div className="flex items-center gap-2">
          <Button disabled={save.isPending || !triggersReady || (quietOn && (!quiet.days.length || quiet.from === quiet.to))} onClick={() => save.mutate()}>
            Save settings
          </Button>
          {message ? (
            <span role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
              {message.text}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
