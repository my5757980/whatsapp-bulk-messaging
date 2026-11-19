'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import type { CampaignDetail, Estimate, Template, VariableSource, VariableSourceKind } from '@/lib/types';

const SOURCES: Array<{ value: VariableSourceKind; label: string }> = [
  { value: 'column', label: 'Uploaded column' },
  { value: 'field', label: 'Contact field' },
  { value: 'attribute', label: 'Contact attribute' },
  { value: 'static', label: 'Same text for everyone' },
];

function isComplete(m: VariableSource | undefined): boolean {
  if (!m) return false;
  return m.source === 'static' ? Boolean(m.value?.trim()) : Boolean(m.key?.trim());
}

/** Step 3 (T110): map each template variable to a column, field, attribute or static text. */
export function MappingStep({ campaign, onBack, onDone }: { campaign: CampaignDetail; onBack: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const template = useQuery({
    queryKey: ['template', campaign.templateId],
    queryFn: () => api<Template>(`/templates/${campaign.templateId}`),
    enabled: Boolean(campaign.templateId),
  });
  const uploaded = campaign.audienceType === 'UPLOAD';
  // Retarget drafts can reuse the original upload's columns (typed by name).
  const allowColumn = uploaded || campaign.audienceType === 'RETARGET';
  const columns = uploaded ? (campaign.audienceUpload?.columns ?? []) : [];
  const defaultSource: VariableSourceKind = uploaded ? 'column' : 'field';
  const sources = allowColumn ? SOURCES : SOURCES.filter((s) => s.value !== 'column');
  const [mapping, setMapping] = useState<Record<string, VariableSource>>(campaign.variableMapping ?? {});
  const [previews, setPreviews] = useState<Estimate['previews'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const variables = template.data?.variables ?? [];

  const update = (key: string, patch: Partial<VariableSource>) =>
    setMapping((current) => ({ ...current, [key]: { source: defaultSource, ...current[key], ...patch } }));

  const save = useMutation({
    mutationFn: async (next: 'preview' | 'continue') => {
      const clean = Object.fromEntries(
        variables.map(({ key }) => {
          const m = mapping[key] ?? { source: defaultSource };
          const fallback = m.fallback?.trim() ? m.fallback.trim() : null;
          return [key, m.source === 'static' ? { source: 'static', value: m.value ?? '', fallback } : { source: m.source, key: m.key ?? '', fallback }];
        }),
      );
      await api(`/campaigns/${campaign.id}`, { method: 'PATCH', json: { variableMapping: clean } });
      await queryClient.invalidateQueries({ queryKey: queryKeys.campaign(campaign.id) });
      if (next === 'preview') setPreviews((await api<Estimate>(`/campaigns/${campaign.id}/estimate`, { method: 'POST' })).previews);
      return next;
    },
    onSuccess: (next) => {
      if (next === 'continue') onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (template.isLoading) return <p className="text-sm text-muted-foreground">Loading template…</p>;
  const body = template.data?.components.find((c) => c.type.toUpperCase() === 'BODY')?.text ?? '';
  const ready = variables.every(({ key }) => isComplete(mapping[key]));

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="rounded-md border bg-muted/40 p-4 text-sm">
        <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Template text</div>
        <p className="whitespace-pre-wrap">{body}</p>
      </div>
      {!variables.length ? <p className="text-sm text-muted-foreground">This template has no variables. Continue to review.</p> : null}
      {variables.map(({ key, example }) => {
        const m = mapping[key] ?? { source: defaultSource };
        const id = key.replace(/\W/g, '-');
        return (
          <div key={key} className="grid gap-3 rounded-md border p-4 sm:grid-cols-[10rem_1fr_1fr_1fr]" data-testid={`mapping-${key}`}>
            <div>
              <div className="font-mono text-sm font-medium">{key}</div>
              {example ? <div className="text-xs text-muted-foreground">e.g. {example}</div> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-source`}>Source</Label>
              <NativeSelect id={`${id}-source`} value={m.source} onChange={(e) => update(key, { source: e.target.value as VariableSourceKind, key: '', value: '' })}>
                {sources.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-value`}>{m.source === 'static' ? 'Text' : m.source === 'attribute' ? 'Attribute key' : 'Value from'}</Label>
              {m.source === 'column' && !columns.length ? (
                <Input id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })} placeholder="column name" />
              ) : m.source === 'column' ? (
                <NativeSelect id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })}>
                  <option value="">Choose a column…</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </NativeSelect>
              ) : m.source === 'field' ? (
                <NativeSelect id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })}>
                  <option value="">Choose a field…</option>
                  <option value="name">Name</option>
                  <option value="phone">Phone</option>
                </NativeSelect>
              ) : m.source === 'attribute' ? (
                <Input id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })} placeholder="city" />
              ) : (
                <Input id={`${id}-value`} value={m.value ?? ''} onChange={(e) => update(key, { value: e.target.value })} />
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-fallback`}>Fallback if empty</Label>
              <Input id={`${id}-fallback`} value={m.fallback ?? ''} onChange={(e) => update(key, { fallback: e.target.value })} placeholder="there" />
            </div>
          </div>
        );
      })}
      {previews ? (
        <div className="grid gap-2" data-testid="previews">
          <div className="text-sm font-medium">Preview</div>
          {previews.map((p) => (
            <div key={p.phoneMasked} className="rounded-md border p-3 text-sm">
              <div className="text-xs text-muted-foreground">{p.phoneMasked}</div>
              <div>{p.text}</div>
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button variant="secondary" onClick={() => save.mutate('preview')} disabled={!ready || save.isPending}>
          Preview
        </Button>
        <Button onClick={() => save.mutate('continue')} disabled={!ready || save.isPending}>
          Save and continue
        </Button>
      </div>
    </div>
  );
}
