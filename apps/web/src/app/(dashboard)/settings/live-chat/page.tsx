'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';

interface LiveChatSettings {
  timezone: string;
  workingHours: Record<string, Array<[string, string]>>;
  welcomeEnabled: boolean;
  welcomeContent: unknown;
  offHoursEnabled: boolean;
  offHoursContent: unknown;
  humanKeywords: string[];
  autoResolve: boolean;
}

/** Settings > Live chat (T055): "talk to a person" keywords and auto-close. Hours and automatic messages arrive with US6. */
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

  const save = useMutation({
    mutationFn: (body: LiveChatSettings) => api<LiveChatSettings>('/live-chat/settings', { method: 'PUT', json: body }),
    onSuccess: (saved) => {
      toast.success('Live chat settings saved');
      queryClient.setQueryData(['live-chat-settings'], saved);
    },
    onError: (error) => toast.error(error instanceof ApiError ? (error.details?.[0]?.issue ?? error.message) : 'The settings could not be saved'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const list = keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    save.mutate({ ...settings, humanKeywords: list, autoResolve });
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-6">
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
      <div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
