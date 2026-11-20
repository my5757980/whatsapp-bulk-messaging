'use client';

import { useQuery } from '@tanstack/react-query';
import type { StepOf } from '@wbm/shared';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { flowKeys, type FlowSummary } from '@/lib/flows';
import type { StepPatch } from './step-form';

type JumpStep = StepOf<'jump'>;

/** Jump step (FR-016): this flow ends and a published flow continues from its first step. */
export function JumpForm({ step, onPatch }: { step: JumpStep; onPatch: StepPatch<JumpStep> }) {
  const flows = useQuery({ queryKey: flowKeys.list, queryFn: () => api<FlowSummary[]>('/flows') });
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="jump-flow">Continue in the flow</Label>
        <NativeSelect id="jump-flow" value={step.flowId ?? ''} onChange={(e) => onPatch({ flowId: e.target.value || null })}>
          <option value="">Choose a flow…</option>
          {step.flowId && flows.isSuccess && !flows.data.some((f) => f.id === step.flowId) && <option value={step.flowId}>A deleted flow</option>}
          {flows.data?.map((flow) => (
            <option key={flow.id} value={flow.id}>
              {flow.name}
              {flow.status === 'PUBLISHED' ? '' : ' (not published)'}
            </option>
          ))}
        </NativeSelect>
      </div>
      <p className="text-xs text-muted-foreground">This flow ends here and the chosen flow starts from its first step, with the answers so far. Only published flows can be used.</p>
    </div>
  );
}
