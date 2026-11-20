'use client';

import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type DelayStep = StepOf<'delay'>;
const UNITS = { seconds: 1, minutes: 60, hours: 3600 } as const;
type Unit = keyof typeof UNITS;

/** Delay step (FR-013): wait 5 seconds to 23 hours before the next step. */
export function DelayForm({ step, graph, onPatch }: { step: DelayStep; graph: FlowGraph; onPatch: StepPatch<DelayStep> }) {
  const [unit, setUnit] = useState<Unit>(step.seconds % 3600 === 0 ? 'hours' : step.seconds % 60 === 0 ? 'minutes' : 'seconds');
  const amount = Math.round((step.seconds / UNITS[unit]) * 100) / 100;

  return (
    <div className="grid gap-3">
      <div className="flex items-end gap-2">
        <div className="grid flex-1 gap-1">
          <Label htmlFor="delay-amount">Wait for</Label>
          <Input
            id="delay-amount"
            type="number"
            min={0}
            step="any"
            value={amount}
            onChange={(e) => {
              const seconds = Math.round(Number(e.target.value) * UNITS[unit]);
              if (Number.isFinite(seconds) && seconds >= FLOW_LIMITS.delaySecondsMin && seconds <= FLOW_LIMITS.delaySecondsMax) onPatch({ seconds }, 'seconds');
            }}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="delay-unit">Unit</Label>
          <NativeSelect id="delay-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
            <option value="seconds">seconds</option>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </NativeSelect>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">From 5 seconds to 23 hours. Messages from the customer meanwhile do not move the flow on.</p>
      <GoesToSelect id="delay-next" label="Then go to" graph={graph} fromId={step.id} value={step.next} onChange={(next) => onPatch({ next })} />
    </div>
  );
}
