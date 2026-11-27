'use client';

import { FLOW_LIMITS, type FlowGraph, type FlowStep, type Problem } from '@wbm/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { STEP_LABELS, updateStep } from '@/lib/flows';
import type { FlowSecret } from '../secrets-panel';
import type { GraphChange } from '../use-graph-history';
import { AiAgentForm } from './ai-agent-form';
import { ApiStepForm } from './api-step-form';
import { ButtonsForm } from './buttons-form';
import { TEXTAREA_CLASS } from './form-bits';
import { AttributesForm } from './attributes-form';
import { ConditionForm } from './condition-form';
import { DelayForm } from './delay-form';
import { JumpForm } from './jump-form';
import { ListForm } from './list-form';
import { MessageForm } from './message-form';
import { CatalogStepForm, FormStepForm, ProductStepForm } from './commerce-forms';
import { PaymentForm } from './payment-form';
import { QuestionForm } from './question-form';
import { TagsForm } from './tags-form';

/** Changes fields of the selected step; `key` names the field so rapid edits are one undo step. */
export type StepPatch<T extends FlowStep> = (values: Partial<T>, key?: string) => void;

interface StepFormProps {
  step: FlowStep;
  graph: FlowGraph;
  isStart: boolean;
  problems: Problem[];
  onChange: GraphChange;
  onSetStart: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** For API steps: the flow (test requests) and its secrets (header values). */
  flowId: string;
  secrets: FlowSecret[];
}

/** The side panel for the selected step: its problems, its form and step actions. */
export function StepForm({ step, graph, isStart, problems, onChange, onSetStart, onDuplicate, onDelete, flowId, secrets }: StepFormProps) {
  const patch: StepPatch<FlowStep> = (values, key) =>
    onChange((g) => updateStep(g, step.id, (current) => ({ ...current, ...values }) as FlowStep), key ? `${step.id}:${key}` : undefined);

  return (
    <div className="grid gap-4" data-testid="step-form">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {STEP_LABELS[step.type]} <span className="font-normal text-muted-foreground">({step.id})</span>
        </h2>
        {isStart && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">Start</span>}
      </div>
      {problems.length > 0 && (
        <ul className="grid gap-1 rounded-md border border-destructive/40 p-2" aria-label="Problems in this step">
          {problems.map((problem, i) => (
            <li key={i} className="text-xs text-destructive">
              {problem.message}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-1">
        <Label htmlFor="step-label">Name on the canvas (optional)</Label>
        <Input id="step-label" value={step.label ?? ''} maxLength={FLOW_LIMITS.label} onChange={(e) => patch({ label: e.target.value || undefined }, 'label')} />
      </div>
      {step.type === 'message' && <MessageForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'buttons' && <ButtonsForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'question' && <QuestionForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'list' && <ListForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'tags' && <TagsForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'attributes' && <AttributesForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'condition' && <ConditionForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'delay' && <DelayForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'jump' && <JumpForm step={step} onPatch={patch} />}
      {step.type === 'aiAgent' && <AiAgentForm step={step} onPatch={patch} />}
      {step.type === 'handover' && (
        <div className="grid gap-1">
          <Label htmlFor="handover-note">Note for the team (optional)</Label>
          <textarea
            id="handover-note"
            className={TEXTAREA_CLASS}
            value={step.note ?? ''}
            maxLength={FLOW_LIMITS.handoverNote}
            onChange={(e) => patch({ note: e.target.value || undefined }, 'note')}
          />
          <p className="text-xs text-muted-foreground">The chat moves to Waiting for agent and the flow ends.</p>
        </div>
      )}
      {step.type === 'end' && <p className="text-sm text-muted-foreground">The flow ends here. The chat stays open for your team.</p>}
      {step.type === 'api' && <ApiStepForm step={step} graph={graph} flowId={flowId} secrets={secrets} onPatch={patch} />}
      {step.type === 'payment' && <PaymentForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'product' && <ProductStepForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'catalog' && <CatalogStepForm step={step} graph={graph} onPatch={patch} />}
      {step.type === 'form' && <FormStepForm step={step} graph={graph} onPatch={patch} />}
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button type="button" size="sm" variant="outline" onClick={onSetStart} disabled={isStart}>
          {isStart ? 'Start step' : 'Make this the start'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDelete}>
          Delete step
        </Button>
      </div>
    </div>
  );
}
