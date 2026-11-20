'use client';

import { branchesOf, type FlowStep, type Problem } from '@wbm/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { branchLabel, STEP_LABELS, stepSummary } from '@/lib/flows';
import { cn } from '@/lib/utils';

export type StepNodeData = { step: FlowStep; isStart: boolean; problems: Problem[] };
export type StepNodeType = Node<StepNodeData, 'step'>;

/** A step on the canvas: its kind, a summary and one connector per way out. */
export function StepNode({ data, selected }: NodeProps<StepNodeType>) {
  const { step, isStart, problems } = data;
  const exits = branchesOf(step);
  return (
    <div
      data-testid="flow-step"
      data-step-id={step.id}
      className={cn(
        'relative w-60 rounded-lg border bg-card text-card-foreground shadow-sm',
        problems.length > 0 && 'border-destructive',
        selected && 'ring-2 ring-primary',
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{STEP_LABELS[step.type]}</span>
        <span className="flex items-center gap-1 text-xs">
          {isStart && <span className="rounded-full bg-primary px-2 py-0.5 font-medium text-primary-foreground">Start</span>}
          {problems.length > 0 && (
            <span
              className="rounded-full bg-destructive px-2 py-0.5 font-medium text-destructive-foreground"
              title={problems.map((p) => p.message).join('\n')}
            >
              {problems.length === 1 ? '1 problem' : `${problems.length} problems`}
            </span>
          )}
        </span>
      </div>
      <p className="line-clamp-3 whitespace-pre-line break-words px-3 py-2 text-sm">{step.label || stepSummary(step)}</p>
      {exits.length > 0 && (
        <ul className="border-t py-1">
          {exits.map((exit) => (
            <li
              key={exit.branch}
              className={cn('relative px-3 py-1 text-right text-xs', exit.required && exit.target === null ? 'text-destructive' : 'text-muted-foreground')}
            >
              {branchLabel(step, exit.branch)}
              <Handle type="source" position={Position.Right} id={exit.branch} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
