import type { FlowGraph, FlowStep } from '@wbm/shared';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { STEP_LABELS, stepSummary } from '@/lib/flows';

/** How a step appears in "goes to" lists: its kind and a short summary. */
export function stepOptionLabel(step: FlowStep, self: boolean): string {
  const text = (step.label || stepSummary(step)).replace(/\s+/g, ' ').trim();
  const short = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return `${STEP_LABELS[step.type]}: ${short}${self ? ' (this step)' : ''}`;
}

interface GoesToSelectProps {
  id: string;
  label: string;
  graph: FlowGraph;
  fromId: string;
  value: string | null;
  /** A branch that must lead somewhere before publishing. */
  required?: boolean;
  onChange: (target: string | null) => void;
}

/** Picks where a branch leads, as an alternative to drawing the connection on the canvas. */
export function GoesToSelect({ id, label, graph, fromId, value, required = false, onChange }: GoesToSelectProps) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value ?? ''} aria-invalid={required && value === null ? true : undefined} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{required ? 'Choose a step…' : 'End the flow here'}</option>
        {graph.steps.map((step) => (
          <option key={step.id} value={step.id}>
            {stepOptionLabel(step, step.id === fromId)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
