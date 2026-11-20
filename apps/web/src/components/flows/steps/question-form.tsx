'use client';

import { useQuery } from '@tanstack/react-query';
import { FLOW_LIMITS, type AnswerSpec, type FlowGraph, type StepOf } from '@wbm/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition } from '@/lib/types';
import { attributeFits, AttributeSelect } from './attribute-select';
import { FallbacksEditor } from './fallbacks-editor';
import { cleanAnswerName, TEXTAREA_CLASS, VariablesHint } from './form-bits';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type QuestionStep = StepOf<'question'>;
type AnswerKind = AnswerSpec['kind'];

const KINDS: Array<{ kind: AnswerKind; label: string }> = [
  { kind: 'text', label: 'Text' },
  { kind: 'number', label: 'Number' },
  { kind: 'email', label: 'Email' },
  { kind: 'phone', label: 'Phone number' },
  { kind: 'date', label: 'Date' },
];

/** An optional whole or decimal number from an input; null when the text is not a number. */
function numberOrUndefined(value: string, integer = false): number | undefined | null {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return null;
  return n;
}

/** Question step (FR-009): one answer of a kind, retries with a prompt, then the invalid branch. */
export function QuestionForm({ step, graph, onPatch }: { step: QuestionStep; graph: FlowGraph; onPatch: StepPatch<QuestionStep> }) {
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const answer = step.answer;

  function setKind(kind: AnswerKind) {
    const saved = attributes.data?.find((a) => a.key === step.saveTo?.attributeKey);
    // Changing the kind clears its limits, and the attribute when it no longer fits.
    onPatch({ answer: { kind } as AnswerSpec, ...(saved && !attributeFits(saved, kind) ? { saveTo: undefined } : {}) });
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="question-text">Question</Label>
        <textarea id="question-text" className={TEXTAREA_CLASS} value={step.text} maxLength={FLOW_LIMITS.questionText} onChange={(e) => onPatch({ text: e.target.value }, 'text')} />
        <VariablesHint />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="question-kind">Answer type</Label>
        <NativeSelect id="question-kind" value={answer.kind} onChange={(e) => setKind(e.target.value as AnswerKind)}>
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {answer.kind === 'text' && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id="question-min-length"
            label="Shortest (characters)"
            value={answer.minLength}
            integer
            min={0}
            max={FLOW_LIMITS.textMaxLength}
            onChange={(minLength) => onPatch({ answer: { ...answer, minLength } }, 'minLength')}
          />
          <NumberField
            id="question-max-length"
            label="Longest (characters)"
            value={answer.maxLength}
            integer
            min={1}
            max={FLOW_LIMITS.textMaxLength}
            onChange={(maxLength) => onPatch({ answer: { ...answer, maxLength } }, 'maxLength')}
          />
        </div>
      )}
      {answer.kind === 'number' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NumberField id="question-min" label="Smallest" value={answer.min} onChange={(min) => onPatch({ answer: { ...answer, min } }, 'min')} />
            <NumberField id="question-max" label="Largest" value={answer.max} onChange={(max) => onPatch({ answer: { ...answer, max } }, 'max')} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={answer.integer ?? false} onChange={(e) => onPatch({ answer: { ...answer, integer: e.target.checked || undefined } })} />
            Whole numbers only
          </label>
        </>
      )}
      {answer.kind === 'date' && (
        <div className="grid grid-cols-2 gap-2">
          <DateBoundField id="question-earliest" label="Earliest" value={answer.earliest} relative onChange={(earliest) => onPatch({ answer: { ...answer, earliest } })} />
          <DateBoundField id="question-latest" label="Latest" value={answer.latest} onChange={(latest) => onPatch({ answer: { ...answer, latest } })} />
        </div>
      )}
      <div className="grid gap-1">
        <Label htmlFor="question-answer">Answer name</Label>
        <Input
          id="question-answer"
          value={step.answerName ?? ''}
          maxLength={40}
          placeholder="e.g. visit_date"
          onChange={(e) => onPatch({ answerName: cleanAnswerName(e.target.value) }, 'answerName')}
        />
        <p className="text-xs text-muted-foreground">Later steps can use the answer as {`{answer:${step.answerName ?? 'name'}}`}.</p>
      </div>
      <AttributeSelect
        id="question-save"
        kind={answer.kind}
        value={step.saveTo?.attributeKey}
        onChange={(key) => onPatch({ saveTo: key ? { attributeKey: key } : undefined })}
      />
      <div className="grid gap-1">
        <Label htmlFor="question-retries">Retries after a wrong answer</Label>
        <Input
          id="question-retries"
          type="number"
          min={0}
          max={FLOW_LIMITS.retriesMax}
          value={step.retries}
          onChange={(e) => {
            const retries = Number(e.target.value);
            if (Number.isInteger(retries) && retries >= 0 && retries <= FLOW_LIMITS.retriesMax) onPatch({ retries }, 'retries');
          }}
        />
      </div>
      {step.retries > 0 && (
        <div className="grid gap-1">
          <Label htmlFor="question-retry-text">Message after a wrong answer</Label>
          <textarea
            id="question-retry-text"
            className={TEXTAREA_CLASS}
            value={step.retryText}
            maxLength={FLOW_LIMITS.retryText}
            onChange={(e) => onPatch({ retryText: e.target.value }, 'retryText')}
          />
        </div>
      )}
      <div className="grid gap-1">
        <Label htmlFor="question-timeout">Wait for an answer (minutes)</Label>
        <Input
          id="question-timeout"
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
      <GoesToSelect id="question-next" label="After a valid answer, go to" graph={graph} fromId={step.id} value={step.next} required onChange={(next) => onPatch({ next })} />
      <GoesToSelect id="question-on-invalid" label="After the last wrong answer, go to" graph={graph} fromId={step.id} value={step.onInvalid} onChange={(onInvalid) => onPatch({ onInvalid })} />
      <GoesToSelect id="question-on-timeout" label="If there is no answer in time, go to" graph={graph} fromId={step.id} value={step.onTimeout} onChange={(onTimeout) => onPatch({ onTimeout })} />
      <FallbacksEditor texts={[step.text, step.retryText]} fallbacks={step.fallbacks} onChange={(fallbacks) => onPatch({ fallbacks }, 'fallbacks')} />
    </div>
  );
}

function NumberField({ id, label, value, integer = false, min, max, onChange }: { id: string; label: string; value: number | undefined; integer?: boolean; min?: number; max?: number; onChange: (value: number | undefined) => void }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value ?? ''}
        placeholder="Any"
        onChange={(e) => {
          const next = numberOrUndefined(e.target.value, integer);
          if (next === null) return;
          if (next !== undefined && ((min !== undefined && next < min) || (max !== undefined && next > max))) return;
          onChange(next);
        }}
      />
    </div>
  );
}

/** Earliest or latest date: none, today or tomorrow (earliest only), or a fixed date. */
function DateBoundField({ id, label, value, relative = false, onChange }: { id: string; label: string; value: string | undefined; relative?: boolean; onChange: (value: string | undefined) => void }) {
  const mode = value === undefined ? '' : value === 'today' || value === 'tomorrow' ? value : 'date';
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={mode}
        onChange={(e) => {
          const next = e.target.value;
          if (next === '') onChange(undefined);
          else if (next === 'date') onChange(new Date().toISOString().slice(0, 10));
          else onChange(next);
        }}
      >
        <option value="">Any date</option>
        {relative && <option value="today">Today</option>}
        {relative && <option value="tomorrow">Tomorrow</option>}
        <option value="date">A date…</option>
      </NativeSelect>
      {mode === 'date' && (
        <Input
          type="date"
          aria-label={`${label} date`}
          value={value}
          onChange={(e) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange(e.target.value);
          }}
        />
      )}
    </div>
  );
}
