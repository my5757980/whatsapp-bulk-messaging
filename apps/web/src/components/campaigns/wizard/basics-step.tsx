'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { titleCase } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import type { Campaign, Template, WhatsAppNumber } from '@/lib/types';

/** Step 1 (T109): name, sending number and an approved template from the same account. */
export function BasicsStep({ campaign, onSaved }: { campaign: Campaign | undefined; onSaved: (c: Campaign) => void }) {
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const templates = useQuery({
    queryKey: queryKeys.templates({ status: 'APPROVED' }),
    queryFn: () => api<Template[]>('/templates?status=APPROVED'),
  });
  const [name, setName] = useState(campaign?.name ?? '');
  const [numberId, setNumberId] = useState(campaign?.numberId ?? '');
  const [templateId, setTemplateId] = useState(campaign?.templateId ?? '');
  const [error, setError] = useState<string | null>(null);

  const connected = (numbers.data ?? []).filter((n) => n.connectionStatus === 'CONNECTED');
  const selectedNumber = connected.find((n) => n.id === numberId);
  const usable = (templates.data ?? []).filter((t) => !selectedNumber || t.wabaId === selectedNumber.wabaId);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), numberId, templateId };
      if (!campaign) return api<Campaign>('/campaigns', { method: 'POST', json: { ...body, audienceType: 'UPLOAD' } });
      const templateChanged = campaign.templateId !== templateId;
      return api<Campaign>(`/campaigns/${campaign.id}`, { method: 'PATCH', json: templateChanged ? { ...body, variableMapping: {} } : body });
    },
    onSuccess: onSaved,
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim() || !numberId || !templateId) {
      setError('Enter a name and choose a number and a template.');
      return;
    }
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="grid max-w-xl gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor="campaign-name">Campaign name</Label>
        <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="November order updates" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="campaign-number">Send from</Label>
        <NativeSelect
          id="campaign-number"
          value={numberId}
          onChange={(e) => {
            setNumberId(e.target.value);
            setTemplateId('');
          }}
        >
          <option value="">Choose a connected number…</option>
          {connected.map((n) => (
            <option key={n.id} value={n.id} disabled={!n.sendingEnabled}>
              {n.label} ({n.displayPhoneNumber}){n.sendingEnabled ? '' : ' - sending off'}
            </option>
          ))}
        </NativeSelect>
        {numbers.isSuccess && !connected.length ? <p className="text-xs text-destructive">Connect a number in Settings first.</p> : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="campaign-template">Approved template</Label>
        <NativeSelect id="campaign-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!numberId}>
          <option value="">Choose a template…</option>
          {usable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.language} · {titleCase(t.category)}
            </option>
          ))}
        </NativeSelect>
        {numberId && templates.isSuccess && !usable.length ? (
          <p className="text-xs text-muted-foreground">No approved templates for this account yet. Sync templates on the Templates page.</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save and continue'}
        </Button>
      </div>
    </form>
  );
}
