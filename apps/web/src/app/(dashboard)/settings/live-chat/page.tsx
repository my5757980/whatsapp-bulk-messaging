'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { AutoContentEditor, emptyContent, type AutoContent } from '@/components/inbox/auto-content-editor';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';

const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
] as const;
type Day = (typeof DAYS)[number][0];
type Hours = Record<Day, Array<[string, string]>>;

interface LiveChatSettings {
  timezone: string;
  workingHours: Hours;
  welcomeEnabled: boolean;
  welcomeContent: AutoContent | null;
  offHoursEnabled: boolean;
  offHoursContent: AutoContent | null;
  humanKeywords: string[];
  autoResolve: boolean;
}

const zones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

/**
 * Settings > Live chat (T055, T082): "talk to a person" keywords, closing quiet chats, working
 * hours and the welcome and off-hours messages.
 */
export default function LiveChatSettingsPage() {
  return (
    <RequirePermission permission="livechat.settings">
      <Settings />
    </RequirePermission>
  );
}

function Settings() {
  const settings = useQuery({ queryKey: ['live-chat-settings'], queryFn: () => api<LiveChatSettings>('/live-chat/settings') });
  if (!settings.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <SettingsForm key={JSON.stringify(settings.data)} settings={settings.data} />;
}

function SettingsForm({ settings }: { settings: LiveChatSettings }) {
  const queryClient = useQueryClient();
  const [keywords, setKeywords] = useState(settings.humanKeywords.join(', '));
  const [autoResolve, setAutoResolve] = useState(settings.autoResolve);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [hours, setHours] = useState<Hours>(settings.workingHours);
  const [welcomeEnabled, setWelcomeEnabled] = useState(settings.welcomeEnabled);
  const [welcome, setWelcome] = useState<AutoContent>(settings.welcomeContent ?? emptyContent('TEXT'));
  const [offHoursEnabled, setOffHoursEnabled] = useState(settings.offHoursEnabled);
  const [offHours, setOffHours] = useState<AutoContent>(settings.offHoursContent ?? emptyContent('TEXT'));

  const save = useMutation({
    mutationFn: (body: LiveChatSettings) => api<LiveChatSettings>('/live-chat/settings', { method: 'PUT', json: body }),
    onSuccess: (saved) => {
      toast.success('Live chat settings saved');
      queryClient.setQueryData(['live-chat-settings'], saved);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? (error.details?.[0] ? `${error.details[0].field}: ${error.details[0].issue}` : error.message) : 'The settings could not be saved'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const list = keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    save.mutate({
      ...settings,
      humanKeywords: list,
      autoResolve,
      timezone,
      workingHours: hours,
      welcomeEnabled,
      welcomeContent: welcomeEnabled ? welcome : null,
      offHoursEnabled,
      offHoursContent: offHoursEnabled ? offHours : null,
    });
  }

  const setRange = (day: Day, index: number, part: 0 | 1, value: string) =>
    setHours({ ...hours, [day]: hours[day].map((range, i) => (i === index ? ((part === 0 ? [value, range[1]] : [range[0], value]) as [string, string]) : range)) });

  return (
    <form onSubmit={submit} className="grid max-w-3xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Talk to a person</CardTitle>
          <CardDescription>
            When a customer sends one of these words or phrases, the chat moves to Waiting for agent and the team is alerted. Up to 5,
            matched ignoring case and extra spaces.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Label htmlFor="human-keywords">Keywords (comma separated)</Label>
          <Input id="human-keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="agent, talk to a person" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Close quiet chats</CardTitle>
          <CardDescription>Taken chats with no activity for 24 hours go back to Open. When off, a quiet chat stays with its member.</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} />
            Close taken chats after 24 hours without activity
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Working hours</CardTitle>
          <CardDescription>Used for the welcome and off-hours messages. A day without hours is closed.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="timezone">Time zone</Label>
            <Input id="timezone" list="timezones" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            <datalist id="timezones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          {DAYS.map(([day, label]) => (
            <div key={day} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24">{label}</span>
              {hours[day].length === 0 && <span className="text-muted-foreground">Closed</span>}
              {hours[day].map((range, i) => (
                <span key={i} className="flex items-center gap-1">
                  <Input type="time" aria-label={`${label} opens`} className="w-28" value={range[0]} onChange={(e) => setRange(day, i, 0, e.target.value)} />
                  –
                  <Input type="time" aria-label={`${label} closes`} className="w-28" value={range[1]} onChange={(e) => setRange(day, i, 1, e.target.value)} />
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${label} range`} onClick={() => setHours({ ...hours, [day]: hours[day].filter((_, j) => j !== i) })}>
                    ×
                  </Button>
                </span>
              ))}
              {hours[day].length < 4 && (
                <Button type="button" variant="outline" size="sm" onClick={() => setHours({ ...hours, [day]: [...hours[day], ['09:00', '18:00']] })}>
                  Add hours
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Welcome message</CardTitle>
          <CardDescription>Sent once when a customer starts a conversation during working hours (first message, or first after 24 hours).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={welcomeEnabled} onChange={(e) => setWelcomeEnabled(e.target.checked)} />
            Send a welcome message
          </label>
          {welcomeEnabled && <AutoContentEditor id="welcome" value={welcome} onChange={setWelcome} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Off-hours message</CardTitle>
          <CardDescription>Sent when a customer writes outside working hours, at most once per contact every 12 hours.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={offHoursEnabled} onChange={(e) => setOffHoursEnabled(e.target.checked)} />
            Send an off-hours message
          </label>
          {offHoursEnabled && <AutoContentEditor id="off-hours" value={offHours} onChange={setOffHours} />}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">Automatic messages are never sent to opted-out or blocked contacts, or in reply to keywords.</p>
      <div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
