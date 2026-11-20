'use client';

import { FLOW_LIMITS, type FlowGraph, type FlowTrigger, type Problem } from '@wbm/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { newKeywordTrigger } from '@/lib/flows';
import { TEXTAREA_CLASS } from './steps/form-bits';
import type { GraphChange } from './use-graph-history';

type KeywordTrigger = Extract<FlowTrigger, { kind: 'KEYWORD' }>;

/** What starts the flow (US1: keywords; other kinds arrive with US6). */
export function TriggerPanel({ graph, problems, onChange }: { graph: FlowGraph; problems: Problem[]; onChange: GraphChange }) {
  const update = (id: string, next: FlowTrigger, key?: string) =>
    onChange((g) => ({ ...g, triggers: g.triggers.map((t) => (t.id === id ? next : t)) }), key);
  const remove = (id: string) => onChange((g) => ({ ...g, triggers: g.triggers.filter((t) => t.id !== id) }));
  const add = () => onChange((g) => ({ ...g, triggers: [...g.triggers, newKeywordTrigger(g)] }));

  return (
    <section aria-labelledby="triggers-title" className="grid gap-3 rounded-lg border bg-card p-3">
      <div>
        <h2 id="triggers-title" className="text-sm font-semibold">
          Starts when a customer sends
        </h2>
        <p className="text-xs text-muted-foreground">Opt-out, opt-in and &quot;talk to a person&quot; keywords cannot start a flow.</p>
      </div>
      {graph.triggers.length === 0 && <p className="text-xs text-muted-foreground">No keyword yet, so customers cannot start this flow.</p>}
      {graph.triggers.map((trigger, index) =>
        trigger.kind === 'KEYWORD' ? (
          <KeywordTriggerForm
            key={trigger.id}
            trigger={trigger}
            index={index}
            problems={problems.filter((p) => p.triggerId === trigger.id)}
            onChange={(next, key) => update(trigger.id, next, key)}
            onRemove={() => remove(trigger.id)}
          />
        ) : (
          <p key={trigger.id} className="text-xs text-muted-foreground">
            A {trigger.kind.toLowerCase().replace('_', ' ')} trigger (editable in a later version).
          </p>
        ),
      )}
      <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={add} disabled={graph.triggers.length >= FLOW_LIMITS.triggers}>
        Add keyword
      </Button>
    </section>
  );
}

interface KeywordTriggerFormProps {
  trigger: KeywordTrigger;
  index: number;
  problems: Problem[];
  onChange: (next: KeywordTrigger, key?: string) => void;
  onRemove: () => void;
}

function KeywordTriggerForm({ trigger, index, problems, onChange, onRemove }: KeywordTriggerFormProps) {
  const id = `trigger-${trigger.id}`;
  return (
    <div className="grid gap-2 rounded-md border p-2" data-testid="keyword-trigger">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-phrases`}>Keywords {index + 1}</Label>
        <textarea
          id={`${id}-phrases`}
          className={TEXTAREA_CLASS}
          rows={3}
          value={trigger.phrases.join('\n')}
          placeholder={'price\nhow much'}
          onChange={(e) =>
            onChange(
              { ...trigger, phrases: e.target.value.split('\n').slice(0, FLOW_LIMITS.phrases).map((p) => p.slice(0, FLOW_LIMITS.phraseLength)) },
              `${trigger.id}:phrases`,
            )
          }
        />
        <p className="text-xs text-muted-foreground">One word or phrase per line.</p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-match`}>Match</Label>
        <NativeSelect id={`${id}-match`} value={trigger.match} onChange={(e) => onChange({ ...trigger, match: e.target.value === 'EXACT' ? 'EXACT' : 'CONTAINS' })}>
          <option value="CONTAINS">The message contains one of them</option>
          <option value="EXACT">The whole message is one of them</option>
        </NativeSelect>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={trigger.canInterrupt} onChange={(e) => onChange({ ...trigger, canInterrupt: e.target.checked })} />
        Can interrupt another running flow
      </label>
      {problems.map((problem, i) => (
        <p key={i} className="text-xs text-destructive">
          {problem.message}
        </p>
      ))}
      <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={onRemove}>
        Remove keyword
      </Button>
    </div>
  );
}
