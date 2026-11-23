'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { growthKeys, type DripDetail } from '@/lib/growth';
import { queryKeys } from '@/lib/query';
import type { Tag } from '@/lib/types';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<DripDetail>(`/drips/${drip.id}`, {
        method: 'PATCH',
        json: { quietHours: quietOn ? quiet : null, leaveOnReply, leaveOnClick, allowRejoin, stopTagIds },
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
          <Button disabled={save.isPending || (quietOn && (!quiet.days.length || quiet.from === quiet.to))} onClick={() => save.mutate()}>
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
