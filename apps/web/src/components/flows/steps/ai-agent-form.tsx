'use client';

import { useQuery } from '@tanstack/react-query';
import { FLOW_LIMITS, type StepOf } from '@wbm/shared';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { aiKeys, type AgentSummary } from '@/lib/ai';
import { api } from '@/lib/api-client';
import { TEXTAREA_CLASS, VariablesHint } from './form-bits';
import type { StepPatch } from './step-form';

type AiAgentStep = StepOf<'aiAgent'>;

/** Hand to AI agent step (004 FR-033): this flow ends and the chosen AI agent answers the chat from here. */
export function AiAgentForm({ step, onPatch }: { step: AiAgentStep; onPatch: StepPatch<AiAgentStep> }) {
  const agents = useQuery({ queryKey: aiKeys.list, queryFn: () => api<AgentSummary[]>('/ai-agents') });
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="ai-agent">AI agent</Label>
        <NativeSelect id="ai-agent" value={step.agentId ?? ''} onChange={(e) => onPatch({ agentId: e.target.value || null })}>
          <option value="">Choose an agent…</option>
          {step.agentId && agents.isSuccess && !agents.data.some((a) => a.id === step.agentId) && <option value={step.agentId}>A deleted agent</option>}
          {agents.data?.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
              {agent.status === 'PUBLISHED' ? '' : ' (not published)'}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="ai-opening">Message before the agent takes over (optional)</Label>
        <textarea
          id="ai-opening"
          className={TEXTAREA_CLASS}
          value={step.openingMessage ?? ''}
          maxLength={FLOW_LIMITS.aiOpeningMessage}
          onChange={(e) => onPatch({ openingMessage: e.target.value || undefined }, 'openingMessage')}
        />
        <VariablesHint />
      </div>
      <p className="text-xs text-muted-foreground">
        This flow ends here. From the customer&apos;s next message the agent answers, even on a number with another agent. Only published agents can be used.
      </p>
    </div>
  );
}
