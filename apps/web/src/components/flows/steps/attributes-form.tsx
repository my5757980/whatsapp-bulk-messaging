'use client';

import { useQuery } from '@tanstack/react-query';
import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { answerNamesIn } from '@/lib/flows';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition } from '@/lib/types';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type AttributesStep = StepOf<'attributes'>;
type Item = AttributesStep['set'][number];
type Source = 'static' | 'answer' | 'name' | 'phone' | 'clear';

const SOURCES: Array<{ source: Source; label: string }> = [
  { source: 'static', label: 'A fixed value' },
  { source: 'answer', label: 'An answer' },
  { source: 'name', label: 'The contact name' },
  { source: 'phone', label: 'The contact phone' },
  { source: 'clear', label: 'Nothing (clear it)' },
];

const sourceOf = (item: Item): Source => (!item.value ? 'clear' : item.value.source === 'field' ? item.value.key : item.value.source);

function valueFor(source: Source, previous: Item['value'], answers: string[]): Item['value'] {
  switch (source) {
    case 'static':
      return { source: 'static', value: previous?.source === 'static' ? previous.value : '' };
    case 'answer':
      return { source: 'answer', name: previous?.source === 'answer' ? previous.name : (answers[0] ?? 'answer') };
    case 'name':
      return { source: 'field', key: 'name' };
    case 'phone':
      return { source: 'field', key: 'phone' };
    case 'clear':
      return null;
  }
}

/** Attributes step (FR-011): set or clear contact attributes from fixed values, answers or contact fields. */
export function AttributesForm({ step, graph, onPatch }: { step: AttributesStep; graph: FlowGraph; onPatch: StepPatch<AttributesStep> }) {
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const answers = answerNamesIn(graph);
  const unused = (attributes.data ?? []).filter((a) => !step.set.some((item) => item.key === a.key));
  const setItem = (index: number, item: Item, key?: string) => onPatch({ set: step.set.map((it, i) => (i === index ? item : it)) }, key);

  return (
    <div className="grid gap-3">
      {step.set.map((item, index) => {
        const n = index + 1;
        const source = sourceOf(item);
        return (
          <div key={index} className="grid gap-2 rounded-md border p-2" data-testid="attribute-change">
            <div className="grid gap-1">
              <Label htmlFor={`set-${index}-key`}>Attribute {n}</Label>
              <NativeSelect id={`set-${index}-key`} value={item.key} onChange={(e) => setItem(index, { ...item, key: e.target.value })}>
                {!attributes.data?.some((a) => a.key === item.key) && <option value={item.key}>{item.key} (not available)</option>}
                {(attributes.data ?? []).map((a) => (
                  <option key={a.key} value={a.key} disabled={a.key !== item.key && step.set.some((other) => other.key === a.key)}>
                    {a.label} ({a.key})
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`set-${index}-source`}>Value {n}</Label>
              <NativeSelect id={`set-${index}-source`} value={source} onChange={(e) => setItem(index, { ...item, value: valueFor(e.target.value as Source, item.value, answers) })}>
                {SOURCES.map((s) => (
                  <option key={s.source} value={s.source} disabled={s.source === 'answer' && !answers.length}>
                    {s.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {item.value?.source === 'static' && (
              <Input
                aria-label={`Fixed value ${n}`}
                value={item.value.value}
                maxLength={FLOW_LIMITS.textMaxLength}
                onChange={(e) => setItem(index, { ...item, value: { source: 'static', value: e.target.value } }, `set:${index}`)}
              />
            )}
            {item.value?.source === 'answer' && (
              <NativeSelect aria-label={`Answer ${n}`} value={item.value.name} onChange={(e) => setItem(index, { ...item, value: { source: 'answer', name: e.target.value } })}>
                {!answers.includes(item.value.name) && <option value={item.value.name}>{item.value.name} (not in this flow)</option>}
                {answers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => onPatch({ set: step.set.filter((_, i) => i !== index) })}>
              Remove
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="justify-self-start"
        disabled={!unused.length || step.set.length >= FLOW_LIMITS.attributesSet}
        onClick={() => onPatch({ set: [...step.set, { key: unused[0]!.key, value: { source: 'static', value: '' } }] })}
      >
        Add attribute
      </Button>
      {attributes.data?.length === 0 && <p className="text-xs text-muted-foreground">Create contact attributes in Settings first.</p>}
      <GoesToSelect id="attributes-next" label="Then go to" graph={graph} fromId={step.id} value={step.next} onChange={(next) => onPatch({ next })} />
    </div>
  );
}
