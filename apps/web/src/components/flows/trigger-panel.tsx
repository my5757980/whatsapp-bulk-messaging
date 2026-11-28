'use client';

import { useQuery } from '@tanstack/react-query';
import { FLOW_LIMITS, unsafePatternReason, type FlowGraph, type FlowTrigger, type Problem } from '@wbm/shared';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { newTrigger } from '@/lib/flows';
import { queryKeys } from '@/lib/query';
import type { Tag, Template } from '@/lib/types';
import { cleanAnswerName, TEXTAREA_CLASS } from './steps/form-bits';
import type { GraphChange } from './use-graph-history';

type Kind = FlowTrigger['kind'];
type Of<K extends Kind> = Extract<FlowTrigger, { kind: K }>;

const ADD: Array<{ kind: Kind; label: string }> = [
  { kind: 'KEYWORD', label: 'Add keyword' },
  { kind: 'PATTERN', label: 'Add pattern' },
  { kind: 'TEMPLATE_BUTTON', label: 'Add template button' },
  { kind: 'FIRST_MESSAGE', label: 'Add first-message rule' },
];

/** Phrases edited one per line; the split keeps empty lines so the text area behaves normally. */
const phrasesFrom = (text: string) => text.split('\n').slice(0, FLOW_LIMITS.phrases).map((p) => p.slice(0, FLOW_LIMITS.phraseLength));

/**
 * What starts the flow (FR-019, FR-020): keywords, patterns, quick-reply buttons of templates, and
 * first-message rules. Matching order: first-message rules (first message only), exact keyword,
 * contains keyword, pattern, template button.
 */
export function TriggerPanel({ graph, problems, onChange }: { graph: FlowGraph; problems: Problem[]; onChange: GraphChange }) {
  const update = (id: string, next: FlowTrigger, key?: string) => onChange((g) => ({ ...g, triggers: g.triggers.map((t) => (t.id === id ? next : t)) }), key);
  const remove = (id: string) => onChange((g) => ({ ...g, triggers: g.triggers.filter((t) => t.id !== id) }));
  const add = (kind: Kind) => onChange((g) => ({ ...g, triggers: [...g.triggers, newTrigger(g, kind)] }));
  const full = graph.triggers.length >= FLOW_LIMITS.triggers;

  return (
    <section aria-labelledby="triggers-title" className="grid gap-3 rounded-lg border bg-card p-3">
      <div>
        <h2 id="triggers-title" className="text-sm font-semibold">
          Starts when a customer sends
        </h2>
        <p className="text-xs text-muted-foreground">Opt-out, opt-in and &quot;talk to a person&quot; keywords cannot start a flow.</p>
      </div>
      {graph.triggers.length === 0 && <p className="text-xs text-muted-foreground">No trigger yet, so customers cannot start this flow.</p>}
      {graph.triggers.map((trigger, index) => {
        const props = {
          index,
          problems: problems.filter((p) => p.triggerId === trigger.id),
          onRemove: () => remove(trigger.id),
        };
        const change = (next: FlowTrigger, key?: string) => update(trigger.id, next, key);
        switch (trigger.kind) {
          case 'KEYWORD':
            return <KeywordForm key={trigger.id} trigger={trigger} onChange={change} {...props} />;
          case 'PATTERN':
            return <PatternForm key={trigger.id} trigger={trigger} onChange={change} {...props} />;
          case 'TEMPLATE_BUTTON':
            return <TemplateButtonForm key={trigger.id} trigger={trigger} onChange={change} {...props} />;
          case 'FIRST_MESSAGE':
            return <FirstMessageForm key={trigger.id} trigger={trigger} onChange={change} {...props} />;
        }
      })}
      <div className="flex flex-wrap gap-2">
        {ADD.map((item) => (
          <Button key={item.kind} type="button" size="sm" variant="outline" onClick={() => add(item.kind)} disabled={full}>
            {item.label}
          </Button>
        ))}
      </div>
    </section>
  );
}

interface FormProps<T extends FlowTrigger> {
  trigger: T;
  index: number;
  problems: Problem[];
  onChange: (next: T, key?: string) => void;
  onRemove: () => void;
}

function Frame({ testId, problems, onRemove, removeLabel, children }: { testId: string; problems: Problem[]; onRemove: () => void; removeLabel: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 rounded-md border p-2" data-testid={testId}>
      {children}
      {problems.map((problem, i) => (
        <p key={i} className="text-xs text-destructive">
          {problem.message}
        </p>
      ))}
      <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={onRemove}>
        {removeLabel}
      </Button>
    </div>
  );
}

function MatchSelect({ id, value, onChange }: { id: string; value: 'EXACT' | 'CONTAINS'; onChange: (value: 'EXACT' | 'CONTAINS') => void }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>Match</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value === 'EXACT' ? 'EXACT' : 'CONTAINS')}>
        <option value="CONTAINS">The message contains one of them</option>
        <option value="EXACT">The whole message is one of them</option>
      </NativeSelect>
    </div>
  );
}

function InterruptBox({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Can interrupt another running flow
    </label>
  );
}

function KeywordForm({ trigger, index, problems, onChange, onRemove }: FormProps<Of<'KEYWORD'>>) {
  const id = `trigger-${trigger.id}`;
  return (
    <Frame testId="keyword-trigger" problems={problems} onRemove={onRemove} removeLabel="Remove keyword">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-phrases`}>Keywords {index + 1}</Label>
        <textarea
          id={`${id}-phrases`}
          className={TEXTAREA_CLASS}
          rows={3}
          value={trigger.phrases.join('\n')}
          placeholder={'price\nhow much'}
          onChange={(e) => onChange({ ...trigger, phrases: phrasesFrom(e.target.value) }, `${trigger.id}:phrases`)}
        />
        <p className="text-xs text-muted-foreground">One word or phrase per line.</p>
      </div>
      <MatchSelect id={`${id}-match`} value={trigger.match} onChange={(match) => onChange({ ...trigger, match })} />
      <InterruptBox checked={trigger.canInterrupt} onChange={(canInterrupt) => onChange({ ...trigger, canInterrupt })} />
    </Frame>
  );
}

function PatternForm({ trigger, index, problems, onChange, onRemove }: FormProps<Of<'PATTERN'>>) {
  const id = `trigger-${trigger.id}`;
  const unsafe = trigger.pattern.trim() ? unsafePatternReason(trigger.pattern) : null;
  return (
    <Frame testId="pattern-trigger" problems={problems.filter((p) => p.code !== 'UNSAFE_PATTERN' || !unsafe)} onRemove={onRemove} removeLabel="Remove pattern">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-pattern`}>Pattern {index + 1}</Label>
        <Input
          id={`${id}-pattern`}
          className="font-mono"
          value={trigger.pattern}
          maxLength={FLOW_LIMITS.patternLength}
          placeholder="order\s*#?(\d{4,})"
          onChange={(e) => onChange({ ...trigger, pattern: e.target.value }, `${trigger.id}:pattern`)}
        />
        <p className={unsafe ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {unsafe ?? 'A regular expression, without case. The first (…) group is what gets saved.'}
        </p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-answer`}>Save the match as (optional)</Label>
        <Input id={`${id}-answer`} value={trigger.answerName ?? ''} maxLength={40} placeholder="e.g. order" onChange={(e) => onChange({ ...trigger, answerName: cleanAnswerName(e.target.value) }, `${trigger.id}:answer`)} />
      </div>
      <InterruptBox checked={trigger.canInterrupt} onChange={(canInterrupt) => onChange({ ...trigger, canInterrupt })} />
    </Frame>
  );
}

/** Quick-reply button texts of a template, carousel cards included (feature 009). */
const quickReplies = (template: Template | undefined) =>
  (template?.components ?? [])
    .flatMap((c) => (c.type.toUpperCase() === 'CAROUSEL' ? (c.cards ?? []).flatMap((card) => card.components ?? []) : [c]))
    .filter((c) => c.type.toUpperCase() === 'BUTTONS')
    .flatMap((c) => c.buttons ?? [])
    .filter((b) => b.type.toUpperCase() === 'QUICK_REPLY' && b.text)
    .map((b) => b.text!)
    .filter((text, i, all) => all.indexOf(text) === i);

function TemplateButtonForm({ trigger, index, problems, onChange, onRemove }: FormProps<Of<'TEMPLATE_BUTTON'>>) {
  const id = `trigger-${trigger.id}`;
  const templates = useQuery({ queryKey: queryKeys.templates(), queryFn: () => api<Template[]>('/templates') });
  const withButtons = (templates.data ?? []).filter((t) => t.status !== 'DELETED' && quickReplies(t).length > 0);
  const chosen = withButtons.find((t) => t.id === trigger.templateId);
  const buttons = quickReplies(chosen);
  return (
    <Frame testId="template-trigger" problems={problems} onRemove={onRemove} removeLabel="Remove template button">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-template`}>Template {index + 1}</Label>
        <NativeSelect id={`${id}-template`} value={trigger.templateId ?? ''} onChange={(e) => onChange({ ...trigger, templateId: e.target.value || null, buttonText: '' })}>
          <option value="">{templates.isLoading ? 'Loading…' : withButtons.length ? 'Choose a template…' : 'No template has quick-reply buttons'}</option>
          {withButtons.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-button`}>Button {index + 1}</Label>
        <NativeSelect id={`${id}-button`} value={trigger.buttonText} disabled={!chosen} onChange={(e) => onChange({ ...trigger, buttonText: e.target.value })}>
          <option value="">Choose the button…</option>
          {buttons.map((text) => (
            <option key={text} value={text}>
              {text}
            </option>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">Starts when a customer taps this button on the template, for example after a campaign.</p>
      </div>
      <InterruptBox checked={trigger.canInterrupt} onChange={(canInterrupt) => onChange({ ...trigger, canInterrupt })} />
    </Frame>
  );
}

function FirstMessageForm({ trigger, index, problems, onChange, onRemove }: FormProps<Of<'FIRST_MESSAGE'>>) {
  const id = `trigger-${trigger.id}`;
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  return (
    <Frame testId="first-message-trigger" problems={problems} onRemove={onRemove} removeLabel="Remove first-message rule">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-phrases`}>First message words {index + 1}</Label>
        <textarea
          id={`${id}-phrases`}
          className={TEXTAREA_CLASS}
          rows={3}
          value={trigger.phrases.join('\n')}
          placeholder={'sofa ad\nsaw your ad'}
          onChange={(e) => onChange({ ...trigger, phrases: phrasesFrom(e.target.value) }, `${trigger.id}:phrases`)}
        />
        <p className="text-xs text-muted-foreground">Only a contact&apos;s very first message is checked.</p>
      </div>
      <MatchSelect id={`${id}-match`} value={trigger.match} onChange={(match) => onChange({ ...trigger, match })} />
      <div className="grid gap-1">
        <Label htmlFor={`${id}-tag`}>First-message tag {index + 1}</Label>
        <NativeSelect id={`${id}-tag`} value={trigger.tagId ?? ''} onChange={(e) => onChange({ ...trigger, tagId: e.target.value || null })}>
          <option value="">Do not set a tag</option>
          {(tags.data ?? []).map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={trigger.startFlow} onChange={(e) => onChange({ ...trigger, startFlow: e.target.checked })} />
        Also start this flow
      </label>
    </Frame>
  );
}
