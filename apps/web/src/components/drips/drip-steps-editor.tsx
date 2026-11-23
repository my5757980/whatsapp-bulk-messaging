'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { destinationProblem, extractTemplateVariables, isTrackedButtonUrl, parseVariableKey, type MetaTemplateComponent } from '@wbm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { STEP_WAITS, growthKeys, type DripDetail, type DripStepInput, type TrackedLinkConfig } from '@/lib/growth';
import type { Template } from '@/lib/types';

type Source = 'field' | 'attribute' | 'static' | 'tracked';

interface VariableChoice {
  source: Source;
  value: string;
  addCampaignTags?: boolean;
}

interface StepDraft {
  id: string | null;
  templateId: string;
  waitMinutes: number;
  headerMediaAssetId: string | null;
  variables: Record<string, VariableChoice>;
}

function fromDetail(drip: DripDetail): StepDraft[] {
  return drip.stepList.map((s) => {
    const variables: Record<string, VariableChoice> = {};
    for (const [key, raw] of Object.entries(s.variableMapping)) {
      const m = raw as { source?: string; key?: string; value?: string };
      if (m.source === 'static') variables[key] = { source: 'static', value: m.value ?? '' };
      else if (m.source === 'attribute') variables[key] = { source: 'attribute', value: m.key ?? '' };
      else variables[key] = { source: 'field', value: m.key ?? 'name' };
    }
    for (const link of s.trackedLinks) variables[link.variableKey] = { source: 'tracked', value: link.destination, addCampaignTags: link.addCampaignTags };
    return { id: s.id, templateId: s.template.id, waitMinutes: s.waitMinutes, headerMediaAssetId: s.headerMediaAssetId, variables };
  });
}

function toInput(step: StepDraft): DripStepInput {
  const mapping: Record<string, unknown> = {};
  const trackedLinks: DripStepInput['trackedLinks'] = [];
  for (const [key, v] of Object.entries(step.variables)) {
    if (v.source === 'tracked') trackedLinks!.push({ variableKey: key, destination: v.value.trim(), addCampaignTags: Boolean(v.addCampaignTags) });
    else if (v.source === 'static') mapping[key] = { source: 'static', value: v.value };
    else mapping[key] = { source: v.source, key: v.value };
  }
  return { id: step.id, templateId: step.templateId, variableMapping: mapping, headerMediaAssetId: step.headerMediaAssetId, waitMinutes: step.waitMinutes, trackedLinks };
}

/**
 * The steps of a drip (feature 005 US4, FR-019, FR-020): each an approved template of the drip's
 * number, its variables (contact fields, attributes, fixed text or a tracked link) and a wait. On an
 * active drip, saved changes reach only steps contacts have not reached yet (FR-023).
 */
export function DripStepsEditor({ drip, wabaId, editable }: { drip: DripDetail; wabaId: string | null; editable: boolean }) {
  const queryClient = useQueryClient();
  const templates = useQuery({ queryKey: ['templates', 'approved'], queryFn: () => api<Template[]>('/templates?status=APPROVED') });
  const linkConfig = useQuery({ queryKey: growthKeys.linkConfig, queryFn: () => api<TrackedLinkConfig>('/tracked-links/config'), staleTime: 5 * 60_000 });
  const [steps, setSteps] = useState<StepDraft[]>(() => fromDetail(drip));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const usable = (templates.data ?? []).filter((t) => !wabaId || t.wabaId === wabaId);
  const byId = new Map((templates.data ?? []).map((t) => [t.id, t]));
  const base = linkConfig.data?.baseUrl ?? undefined;

  /** Every variable of the step's template with a choice; untouched ones get what the form shows. */
  const effective = (step: StepDraft): StepDraft => {
    const template = byId.get(step.templateId);
    if (!template) return step;
    const components = template.components as unknown as MetaTemplateComponent[];
    const buttons = components.find((c) => c.type.toUpperCase() === 'BUTTONS')?.buttons ?? [];
    const variables: Record<string, VariableChoice> = {};
    for (const { key } of extractTemplateVariables(components)) {
      const ref = parseVariableKey(key);
      const trackedButton = ref?.component === 'BUTTON' && isTrackedButtonUrl(buttons[ref.index ?? 0]?.url ?? '', base);
      variables[key] = step.variables[key] ?? (trackedButton ? { source: 'tracked', value: '' } : { source: 'field', value: 'name' });
    }
    return { ...step, variables };
  };

  const save = useMutation({
    mutationFn: () => api<DripDetail>(`/drips/${drip.id}/steps`, { method: 'PUT', json: { steps: steps.map((s) => toInput(effective(s))) } }),
    onSuccess: async (saved) => {
      setSteps(fromDetail(saved));
      setMessage({ ok: true, text: 'Steps saved' });
      await queryClient.invalidateQueries({ queryKey: growthKeys.drip(drip.id) });
    },
    onError: (e) => setMessage({ ok: false, text: errorMessage(e) }),
  });

  const update = (i: number, patch: Partial<StepDraft>) => {
    setMessage(null);
    setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const setVariable = (i: number, key: string, choice: VariableChoice) =>
    update(i, { variables: { ...steps[i]!.variables, [key]: choice } });

  return (
    <div className="grid gap-4">
      {steps.map((step, i) => {
        const template = byId.get(step.templateId);
        const components = (template?.components ?? []) as unknown as MetaTemplateComponent[];
        const buttons = components.find((c) => c.type.toUpperCase() === 'BUTTONS')?.buttons ?? [];
        const variables = template ? extractTemplateVariables(components) : [];
        return (
          <Card key={step.id ?? `new-${i}`} data-testid={`drip-step-${i + 1}`}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">Step {i + 1}</CardTitle>
              {editable ? (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => setSteps((all) => all.map((s, j) => (j === i - 1 ? all[i]! : j === i ? all[i - 1]! : s)))}>
                    Move up
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>
                    Remove step
                  </Button>
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={`step-${i}-template`}>Template</Label>
                  <NativeSelect id={`step-${i}-template`} value={step.templateId} disabled={!editable} onChange={(e) => update(i, { templateId: e.target.value, variables: {} })}>
                    <option value="">Choose an approved template…</option>
                    {usable.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {t.language}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`step-${i}-wait`}>Wait</Label>
                  <NativeSelect id={`step-${i}-wait`} value={String(step.waitMinutes)} disabled={!editable} onChange={(e) => update(i, { waitMinutes: Number(e.target.value) })}>
                    {STEP_WAITS.filter((w) => i === 0 || w.minutes > 0).map((w) => (
                      <option key={w.minutes} value={w.minutes}>
                        {w.minutes === 0 ? w.label : `${w.label} ${i === 0 ? 'after joining' : 'after the previous step'}`}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              {variables.map(({ key, example }) => {
                const ref = parseVariableKey(key);
                const isButton = ref?.component === 'BUTTON';
                const trackedButton = isButton && isTrackedButtonUrl(buttons[ref?.index ?? 0]?.url ?? '', base);
                const choice = step.variables[key] ?? (trackedButton ? { source: 'tracked' as const, value: '' } : { source: 'field' as const, value: 'name' });
                const id = `step-${i}-${key.replace(/\W/g, '-')}`;
                return (
                  <div key={key} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[9rem_1fr_2fr]" data-testid={`step-mapping-${key}`}>
                    <div>
                      <div className="font-mono text-sm">{key}</div>
                      {example ? <div className="text-xs text-muted-foreground">e.g. {example}</div> : null}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${id}-source`}>Source</Label>
                      <NativeSelect
                        id={`${id}-source`}
                        value={choice.source}
                        disabled={!editable}
                        onChange={(e) => {
                          const source = e.target.value as Source;
                          setVariable(i, key, { source, value: source === 'field' ? 'name' : '' });
                        }}
                      >
                        {trackedButton ? null : (
                          <>
                            <option value="field">Contact field</option>
                            <option value="attribute">Contact attribute</option>
                            <option value="static">Same text for everyone</option>
                          </>
                        )}
                        {base && (trackedButton || !isButton) ? <option value="tracked">Tracked link</option> : null}
                      </NativeSelect>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${id}-value`}>{choice.source === 'tracked' ? 'Destination address' : 'Value'}</Label>
                      {choice.source === 'field' ? (
                        <NativeSelect id={`${id}-value`} value={choice.value} disabled={!editable} onChange={(e) => setVariable(i, key, { ...choice, value: e.target.value })}>
                          <option value="name">Name</option>
                          <option value="phone">Phone</option>
                        </NativeSelect>
                      ) : (
                        <Input
                          id={`${id}-value`}
                          value={choice.value}
                          disabled={!editable}
                          placeholder={choice.source === 'tracked' ? 'https://shop.example.com/offer' : choice.source === 'attribute' ? 'city' : ''}
                          onChange={(e) => setVariable(i, key, { ...choice, value: e.target.value })}
                        />
                      )}
                      {choice.source === 'tracked' ? (
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={Boolean(choice.addCampaignTags)}
                            disabled={!editable}
                            onChange={(e) => setVariable(i, key, { ...choice, addCampaignTags: e.target.checked })}
                          />
                          Add campaign tags
                        </label>
                      ) : null}
                      {choice.source === 'tracked' && choice.value.trim() && destinationProblem(choice.value.trim(), base) ? (
                        <p className="text-xs text-destructive">Enter a full address starting with https://</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })}
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={steps.length >= 10}
            onClick={() => setSteps((all) => [...all, { id: null, templateId: '', waitMinutes: all.length ? 1440 : 0, headerMediaAssetId: null, variables: {} }])}
          >
            Add step
          </Button>
          <Button disabled={!steps.length || steps.some((s) => !s.templateId) || save.isPending} onClick={() => save.mutate()}>
            Save steps
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
