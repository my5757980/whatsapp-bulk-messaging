'use client';

import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nextOptionKey } from '@/lib/flows';
import { AttributeSelect } from './attribute-select';
import { FallbacksEditor } from './fallbacks-editor';
import { cleanAnswerName, TEXTAREA_CLASS, VariablesHint } from './form-bits';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type ListStep = StepOf<'list'>;
type Section = ListStep['sections'][number];
type Row = Section['rows'][number];

/** List step: up to 10 options in sections; each option has its own next step, or all share one. */
export function ListForm({ step, graph, onPatch }: { step: ListStep; graph: FlowGraph; onPatch: StepPatch<ListStep> }) {
  const [wantShared, setWantShared] = useState(false);
  const shared = step.sharedNext !== null || wantShared;
  const rowCount = step.sections.reduce((n, s) => n + s.rows.length, 0);
  const newRow = (): Row => ({ key: nextOptionKey(step.sections.flatMap((s) => s.rows.map((r) => r.key)), 'r'), title: `Option ${rowCount + 1}`, next: null });

  const setSections = (sections: Section[], key?: string) => onPatch({ sections }, key);
  const setSection = (index: number, change: (section: Section) => Section, key?: string) =>
    setSections(
      step.sections.map((s, i) => (i === index ? change(s) : s)),
      key,
    );
  const setRow = (index: number, rowKey: string, values: Partial<Row>, field?: string) =>
    setSection(index, (s) => ({ ...s, rows: s.rows.map((r) => (r.key === rowKey ? { ...r, ...values } : r)) }), field && `row:${rowKey}:${field}`);

  let number = 0;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="list-text">Message</Label>
        <textarea id="list-text" className={TEXTAREA_CLASS} value={step.text} maxLength={FLOW_LIMITS.interactiveBody} onChange={(e) => onPatch({ text: e.target.value }, 'text')} />
        <VariablesHint />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="list-button">List button label</Label>
        <Input id="list-button" value={step.buttonLabel} maxLength={FLOW_LIMITS.listButtonLabel} onChange={(e) => onPatch({ buttonLabel: e.target.value }, 'buttonLabel')} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={shared}
          onChange={(e) => {
            setWantShared(e.target.checked);
            if (!e.target.checked) onPatch({ sharedNext: null });
          }}
        />
        Every option goes to the same step
      </label>
      {shared && (
        <GoesToSelect id="list-shared-next" label="All options go to" graph={graph} fromId={step.id} value={step.sharedNext} required onChange={(sharedNext) => onPatch({ sharedNext })} />
      )}
      {step.sections.map((section, index) => (
        <fieldset key={index} className="grid gap-2 rounded-md border p-2">
          <legend className="px-1 text-sm font-medium">Section {index + 1}</legend>
          <div className="grid gap-1">
            <Label htmlFor={`list-section-${index}`}>Section title{step.sections.length > 1 ? '' : ' (optional)'}</Label>
            <Input
              id={`list-section-${index}`}
              value={section.title ?? ''}
              maxLength={FLOW_LIMITS.sectionTitle}
              onChange={(e) => setSection(index, (s) => ({ ...s, title: e.target.value || undefined }), `section:${index}`)}
            />
          </div>
          {section.rows.map((row) => {
            number += 1;
            const n = number;
            return (
              <div key={row.key} className="grid gap-2 rounded-md border p-2" data-testid="list-option">
                <div className="flex items-end gap-2">
                  <div className="grid flex-1 gap-1">
                    <Label htmlFor={`row-${row.key}-title`}>Option {n}</Label>
                    <Input id={`row-${row.key}-title`} value={row.title} maxLength={FLOW_LIMITS.rowTitle} onChange={(e) => setRow(index, row.key, { title: e.target.value }, 'title')} />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove option ${n}`}
                    disabled={rowCount === 1}
                    onClick={() => setSection(index, (s) => ({ ...s, rows: s.rows.filter((r) => r.key !== row.key) }))}
                  >
                    Remove
                  </Button>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`row-${row.key}-description`}>Option {n} description (optional)</Label>
                  <Input
                    id={`row-${row.key}-description`}
                    value={row.description ?? ''}
                    maxLength={FLOW_LIMITS.rowDescription}
                    onChange={(e) => setRow(index, row.key, { description: e.target.value || undefined }, 'description')}
                  />
                </div>
                {!shared && (
                  <GoesToSelect id={`row-${row.key}-next`} label={`Option ${n} goes to`} graph={graph} fromId={step.id} value={row.next} required onChange={(next) => setRow(index, row.key, { next })} />
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            {rowCount < FLOW_LIMITS.listRows && (
              <Button type="button" size="sm" variant="outline" onClick={() => setSection(index, (s) => ({ ...s, rows: [...s.rows, newRow()] }))}>
                Add option
              </Button>
            )}
            {step.sections.length > 1 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setSections(step.sections.filter((_, i) => i !== index))} disabled={rowCount - section.rows.length < 1}>
                Remove section
              </Button>
            )}
          </div>
        </fieldset>
      ))}
      {step.sections.length < FLOW_LIMITS.listSections && rowCount < FLOW_LIMITS.listRows && (
        <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setSections([...step.sections, { rows: [newRow()] }])}>
          Add section
        </Button>
      )}
      <div className="grid gap-1">
        <Label htmlFor="list-answer">Remember the choice as (optional)</Label>
        <Input id="list-answer" value={step.answerName ?? ''} maxLength={40} placeholder="e.g. branch" onChange={(e) => onPatch({ answerName: cleanAnswerName(e.target.value) }, 'answerName')} />
      </div>
      <AttributeSelect id="list-save" kind="text" value={step.saveTo?.attributeKey} onChange={(key) => onPatch({ saveTo: key ? { attributeKey: key } : undefined })} />
      <div className="grid gap-1">
        <Label htmlFor="list-timeout">Wait for a choice (minutes)</Label>
        <Input
          id="list-timeout"
          type="number"
          min={FLOW_LIMITS.timeoutMinutesMin}
          max={FLOW_LIMITS.timeoutMinutesMax}
          value={step.timeoutMinutes}
          onChange={(e) => {
            const minutes = Number(e.target.value);
            if (Number.isInteger(minutes) && minutes >= FLOW_LIMITS.timeoutMinutesMin && minutes <= FLOW_LIMITS.timeoutMinutesMax) onPatch({ timeoutMinutes: minutes }, 'timeout');
          }}
        />
      </div>
      <GoesToSelect id="list-on-timeout" label="If there is no choice in time, go to" graph={graph} fromId={step.id} value={step.onTimeout} onChange={(onTimeout) => onPatch({ onTimeout })} />
      <GoesToSelect id="list-on-invalid" label="If the customer types something else, go to" graph={graph} fromId={step.id} value={step.onInvalid} onChange={(onInvalid) => onPatch({ onInvalid })} />
      <FallbacksEditor texts={[step.text, step.header, step.footer]} fallbacks={step.fallbacks} onChange={(fallbacks) => onPatch({ fallbacks }, 'fallbacks')} />
    </div>
  );
}
