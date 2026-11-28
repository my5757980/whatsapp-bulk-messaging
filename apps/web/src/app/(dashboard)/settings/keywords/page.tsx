'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { KeywordRepliesCard } from '@/components/settings/keyword-replies-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { usePermissions } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { CompanySettings } from '@/lib/types';

const toList = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

/** Settings > Consent keywords, default country and timezone (T130, FR-013), and the keyword replies (010 US4). */
export default function KeywordsPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const settings = useQuery({ queryKey: queryKeys.settings, queryFn: () => api<CompanySettings>('/settings') });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Partial<CompanySettings>) => api<CompanySettings>('/settings', { method: 'PATCH', json: body }),
    onSuccess: (s) => {
      queryClient.setQueryData(queryKeys.settings, s);
      toast.success('Settings saved');
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (settings.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!settings.data) return <p className="text-sm text-destructive">{errorMessage(settings.error)}</p>;
  const s = settings.data;
  const editable = can('settings.manage');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    save.mutate({
      optOutKeywords: toList(form.get('optOut')),
      optInKeywords: toList(form.get('optIn')),
      defaultCountryCode: String(form.get('country') ?? '').trim().toUpperCase(),
      defaultTimezone: String(form.get('timezone') ?? '').trim(),
    });
  }

  const keywords = (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Consent keywords</CardTitle>
        <CardDescription>
          When a customer replies with exactly one of these words (any case), their consent changes within a minute. Opted-out contacts are excluded from
          every campaign.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <fieldset disabled={!editable} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="opt-out">Opt-out keywords (comma separated)</Label>
              <Input id="opt-out" name="optOut" defaultValue={s.optOutKeywords.join(', ')} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="opt-in">Opt-in keywords (comma separated)</Label>
              <Input id="opt-in" name="optIn" defaultValue={s.optInKeywords.join(', ')} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="country">Default country code</Label>
                <Input id="country" name="country" defaultValue={s.defaultCountryCode} maxLength={2} required />
                <p className="text-xs text-muted-foreground">Used for phone numbers entered without a country code.</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="timezone">Default timezone</Label>
                <Input id="timezone" name="timezone" defaultValue={s.defaultTimezone} required placeholder="Asia/Dubai" />
              </div>
            </div>
          </fieldset>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {editable ? (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
  return (
    <div className="grid max-w-2xl gap-6">
      {keywords}
      <KeywordRepliesCard editable={editable} />
    </div>
  );
}
