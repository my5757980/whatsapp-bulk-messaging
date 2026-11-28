'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { automationKeys, offsetText, type AutomationInput, type DateAutomation, type MappingSource } from '@/lib/automations';
import { errorMessage } from '@/lib/errors';
import { useGlobalAttributes } from '@/lib/global-attributes';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, Template, WhatsAppNumber } from '@/lib/types';

const EMPTY: AutomationInput = { name: '', attributeKey: '', timing: 'YEARLY', offsetDays: 0, sendTime: '09:00', numberId: '', templateId: '', variableMapping: {} };
const DEFAULT_SOURCE: MappingSource = { source: 'field', key: 'name', fallback: 'there' };

/**
 * Feature 010 (US5): the date rule (attribute, yearly or once, days before or after, send time), the number and
 * template with its variables, and how many contacts are due on each of the next 7 days.
 */
export function AutomationEditor({ automation, editable }: { automation?: DateAutomation; editable: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AutomationInput>(EMPTY);
  const [loaded, setLoaded] = useState(!automation);
  const [error, setError] = useState<string | null>(null);
  // Fill once from the saved automation; later refetches never overwrite what is being typed.
  useEffect(() => {
    if (automation && !loaded) {
      const { name, attributeKey, timing, offsetDays, sendTime, numberId, templateId, variableMapping } = automation;
      setForm({ name, attributeKey, timing, offsetDays, sendTime, numberId, templateId, variableMapping });
      setLoaded(true);
    }
  }, [automation, loaded]);

  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const templates = useQuery({ queryKey: ['templates', { status: 'APPROVED' }], queryFn: () => api<Template[]>('/templates?status=APPROVED') });
  const globals = useGlobalAttributes();
  const number = numbers.data?.find((n) => n.id === form.numberId);
  const choices = (templates.data ?? []).filter((t) => !number || t.wabaId === number.wabaId);
  const template = templates.data?.find((t) => t.id === form.templateId);
  const dateAttributes = (attributes.data ?? []).filter((a) => a.type === 'DATE');

  const preview = useQuery({
    queryKey: ['date-automations', 'preview', form.attributeKey, form.timing, form.offsetDays],
    queryFn: () => api<{ days: Array<{ date: string; due: number }> }>('/date-automations/preview', { method: 'POST', json: { attributeKey: form.attributeKey, timing: form.timing, offsetDays: form.offsetDays } }),
    enabled: editable && Boolean(form.attributeKey) && Number.isInteger(form.offsetDays) && Math.abs(form.offsetDays) <= 30,
  });

  const save = useMutation({
    mutationFn: () =>
      api<DateAutomation>(automation ? `/date-automations/${automation.id}` : '/date-automations', { method: automation ? 'PUT' : 'POST', json: { ...form, name: form.name.trim() } }),
    onSuccess: async (saved) => {
      setError(null);
      toast.success('Automation saved');
      queryClient.setQueryData(automationKeys.one(saved.id), saved);
      await queryClient.invalidateQueries({ queryKey: automationKeys.list });
      if (!automation) router.push(`/automations/${saved.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const set = (patch: Partial<AutomationInput>) => setForm((f) => ({ ...f, ...patch }));
  const chooseTemplate = (templateId: string) => {
    const chosen = templates.data?.find((t) => t.id === templateId);
    set({ templateId, variableMapping: Object.fromEntries((chosen?.variables ?? []).map((v) => [v.key, form.variableMapping[v.key] ?? DEFAULT_SOURCE])) });
  };
  const setSource = (key: string, next: MappingSource) => set({ variableMapping: { ...form.variableMapping, [key]: next } });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{automation ? 'Settings' : 'New automation'}</CardTitle>
        <CardDescription>Changes apply from the next run. A new automation starts switched off.</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={!editable || !loaded} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="automation-name">Name</Label>
            <Input id="automation-name" value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Birthday wishes" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="automation-attribute">Date attribute</Label>
              <NativeSelect id="automation-attribute" value={form.attributeKey} onChange={(e) => set({ attributeKey: e.target.value })}>
                <option value="">Choose a date attribute</option>
                {dateAttributes.map((a) => (
                  <option key={a.id} value={a.key}>
                    {a.label} ({a.key})
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-timing">Repeat</Label>
              <NativeSelect id="automation-timing" value={form.timing} onChange={(e) => set({ timing: e.target.value as AutomationInput['timing'] })}>
                <option value="YEARLY">Every year on the day and month</option>
                <option value="ONCE">Once, on the exact date</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-offset">Days from the date (negative is before)</Label>
              <Input id="automation-offset" type="number" min={-30} max={30} value={form.offsetDays} onChange={(e) => set({ offsetDays: Number(e.target.value) })} />
              <p className="text-xs text-muted-foreground">Sent {offsetText(form.offsetDays)}.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-time">Send time (company time zone)</Label>
              <Input id="automation-time" type="time" value={form.sendTime} onChange={(e) => set({ sendTime: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-number">Send from</Label>
              <NativeSelect id="automation-number" value={form.numberId} onChange={(e) => set({ numberId: e.target.value, templateId: '', variableMapping: {} })}>
                <option value="">Choose a number</option>
                {(numbers.data ?? []).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label} ({n.displayPhoneNumber})
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-template">Approved template</Label>
              <NativeSelect id="automation-template" value={form.templateId} onChange={(e) => chooseTemplate(e.target.value)} disabled={!form.numberId}>
                <option value="">Choose a template</option>
                {choices.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.language} · {t.category.charAt(0) + t.category.slice(1).toLowerCase()}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          {template?.variables.length ? (
            <div className="grid gap-2">
              <div className="text-sm font-medium">Template variables</div>
              {template.variables.map((v) => {
                const m = form.variableMapping[v.key] ?? DEFAULT_SOURCE;
                return (
                  <div key={v.key} className="grid grid-cols-[90px_1fr_1fr_1fr] items-center gap-1 text-xs" data-testid={`automation-variable-${v.key}`}>
                    <span>{v.key}</span>
                    <NativeSelect aria-label={`${v.key} source`} value={m.source} onChange={(e) => setSource(v.key, { source: e.target.value as MappingSource['source'], fallback: m.fallback })}>
                      <option value="field">Contact field</option>
                      <option value="attribute">Attribute</option>
                      <option value="global">Global attribute</option>
                      <option value="static">Fixed text</option>
                    </NativeSelect>
                    {m.source === 'static' ? (
                      <Input aria-label={`${v.key} value`} value={m.value ?? ''} onChange={(e) => setSource(v.key, { ...m, value: e.target.value })} />
                    ) : m.source === 'global' ? (
                      <NativeSelect aria-label={`${v.key} global attribute`} value={m.key ?? ''} onChange={(e) => setSource(v.key, { ...m, key: e.target.value })}>
                        <option value="">Choose…</option>
                        {(globals.data?.items ?? []).map((g) => (
                          <option key={g.id} value={g.key}>
                            {g.key}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Input aria-label={`${v.key} key`} placeholder={m.source === 'field' ? 'name or phone' : 'attribute key'} value={m.key ?? ''} onChange={(e) => setSource(v.key, { ...m, key: e.target.value })} />
                    )}
                    <Input aria-label={`${v.key} fallback`} placeholder="fallback" value={m.fallback ?? ''} onChange={(e) => setSource(v.key, { ...m, fallback: e.target.value })} />
                  </div>
                );
              })}
            </div>
          ) : null}
          {preview.data ? (
            <div className="grid gap-1" data-testid="due-preview">
              <div className="text-sm font-medium">Due in the next 7 days</div>
              <div className="flex flex-wrap gap-2 text-xs">
                {preview.data.days.map((d) => (
                  <span key={d.date} className="rounded-md border px-2 py-1">
                    {d.date}: <strong>{d.due}</strong>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {editable ? (
            <div>
              <Button type="button" onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim() || !form.attributeKey || !form.numberId || !form.templateId}>
                {save.isPending ? 'Saving…' : automation ? 'Save changes' : 'Create automation'}
              </Button>
            </div>
          ) : null}
        </fieldset>
      </CardContent>
    </Card>
  );
}
