'use client';

import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nextOptionKey } from '@/lib/flows';
import { FallbacksEditor } from './fallbacks-editor';
import { cleanAnswerName, TEXTAREA_CLASS, VariablesHint } from './form-bits';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type ButtonsStep = StepOf<'buttons'>;
type ReplyButton = ButtonsStep['buttons'][number];

/** Buttons step: a message with up to 3 reply buttons, each leading to its own step. */
export function ButtonsForm({ step, graph, onPatch }: { step: ButtonsStep; graph: FlowGraph; onPatch: StepPatch<ButtonsStep> }) {
  const setButton = (key: string, values: Partial<ReplyButton>, field?: string) =>
    onPatch({ buttons: step.buttons.map((b) => (b.key === key ? { ...b, ...values } : b)) }, field && `button:${key}:${field}`);
  const addButton = () =>
    onPatch({ buttons: [...step.buttons, { key: nextOptionKey(step.buttons.map((b) => b.key)), title: `Option ${step.buttons.length + 1}`, next: null }] });
  const removeButton = (key: string) => onPatch({ buttons: step.buttons.filter((b) => b.key !== key) });

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="buttons-text">Message</Label>
        <textarea
          id="buttons-text"
          className={TEXTAREA_CLASS}
          value={step.text}
          maxLength={FLOW_LIMITS.interactiveBody}
          onChange={(e) => onPatch({ text: e.target.value }, 'text')}
        />
        <VariablesHint />
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Buttons (up to {FLOW_LIMITS.buttons})</legend>
        {step.buttons.map((button, i) => (
          <div key={button.key} className="grid gap-2 rounded-md border p-2" data-testid="reply-button">
            <div className="flex items-end gap-2">
              <div className="grid flex-1 gap-1">
                <Label htmlFor={`button-${button.key}-title`}>Button {i + 1}</Label>
                <Input
                  id={`button-${button.key}-title`}
                  value={button.title}
                  maxLength={FLOW_LIMITS.buttonTitle}
                  onChange={(e) => setButton(button.key, { title: e.target.value }, 'title')}
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove button ${i + 1}`}
                disabled={step.buttons.length === 1}
                onClick={() => removeButton(button.key)}
              >
                Remove
              </Button>
            </div>
            <GoesToSelect
              id={`button-${button.key}-next`}
              label={`Button ${i + 1} goes to`}
              graph={graph}
              fromId={step.id}
              value={button.next}
              required
              onChange={(next) => setButton(button.key, { next })}
            />
          </div>
        ))}
        {step.buttons.length < FLOW_LIMITS.buttons && (
          <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={addButton}>
            Add button
          </Button>
        )}
      </fieldset>
      <div className="grid gap-1">
        <Label htmlFor="buttons-timeout">Wait for an answer (minutes)</Label>
        <Input
          id="buttons-timeout"
          type="number"
          min={FLOW_LIMITS.timeoutMinutesMin}
          max={FLOW_LIMITS.timeoutMinutesMax}
          value={step.timeoutMinutes}
          onChange={(e) => {
            const minutes = Number(e.target.value);
            if (Number.isInteger(minutes) && minutes >= FLOW_LIMITS.timeoutMinutesMin && minutes <= FLOW_LIMITS.timeoutMinutesMax) {
              onPatch({ timeoutMinutes: minutes }, 'timeout');
            }
          }}
        />
      </div>
      <GoesToSelect
        id="buttons-on-timeout"
        label="If there is no answer in time, go to"
        graph={graph}
        fromId={step.id}
        value={step.onTimeout}
        onChange={(onTimeout) => onPatch({ onTimeout })}
      />
      <GoesToSelect
        id="buttons-on-invalid"
        label="If the customer types something else, go to"
        graph={graph}
        fromId={step.id}
        value={step.onInvalid}
        onChange={(onInvalid) => onPatch({ onInvalid })}
      />
      <div className="grid gap-1">
        <Label htmlFor="buttons-answer">Remember the answer as (optional)</Label>
        <Input
          id="buttons-answer"
          value={step.answerName ?? ''}
          placeholder="e.g. branch"
          maxLength={40}
          onChange={(e) => onPatch({ answerName: cleanAnswerName(e.target.value) }, 'answerName')}
        />
        <p className="text-xs text-muted-foreground">Later steps can use it, for example {'{answer:branch}'}.</p>
      </div>
      <FallbacksEditor texts={[step.text, step.header, step.footer]} fallbacks={step.fallbacks} onChange={(fallbacks) => onPatch({ fallbacks }, 'fallbacks')} />
    </div>
  );
}
