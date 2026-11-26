'use client';

import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { TEXTAREA_CLASS } from './form-bits';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type PaymentStep = StepOf<'payment'>;

/**
 * Request payment step (feature 008 US3, FR-038): a fixed amount, or one from an answer or a contact
 * attribute; the flow waits, then goes on when paid, or by the not-paid branch when the link expires.
 */
export function PaymentForm({ step, graph, onPatch }: { step: PaymentStep; graph: FlowGraph; onPatch: StepPatch<PaymentStep> }) {
  const amount = step.amount;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="pay-source">Amount from</Label>
        <NativeSelect
          id="pay-source"
          value={amount.source}
          onChange={(e) => {
            const source = e.target.value as PaymentStep['amount']['source'];
            onPatch({ amount: source === 'static' ? { source, minor: 10_000 } : source === 'answer' ? { source, name: 'amount' } : { source, key: 'amount' } }, 'amount');
          }}
        >
          <option value="static">A fixed amount</option>
          <option value="answer">An answer in this flow</option>
          <option value="attribute">A contact attribute</option>
        </NativeSelect>
      </div>
      {amount.source === 'static' ? (
        <div className="grid gap-1">
          <Label htmlFor="pay-amount-fixed">Amount (AED)</Label>
          <Input
            id="pay-amount-fixed"
            type="number"
            min="2"
            step="0.01"
            value={amount.minor / 100}
            onChange={(e) => {
              const minor = Math.round(Number(e.target.value) * 100);
              if (Number.isFinite(minor) && minor >= 1) onPatch({ amount: { source: 'static', minor } }, 'amount');
            }}
          />
        </div>
      ) : (
        <div className="grid gap-1">
          <Label htmlFor="pay-amount-name">{amount.source === 'answer' ? 'Answer name' : 'Attribute key'}</Label>
          <Input
            id="pay-amount-name"
            value={amount.source === 'answer' ? amount.name : amount.key}
            onChange={(e) => onPatch({ amount: amount.source === 'answer' ? { source: 'answer', name: e.target.value.trim() } : { source: 'attribute', key: e.target.value.trim() } }, 'amount')}
          />
          <p className="text-xs text-muted-foreground">The value is read in AED, for example 149.50.</p>
        </div>
      )}
      <div className="grid gap-1">
        <Label htmlFor="pay-description">What it is for</Label>
        <textarea id="pay-description" className={TEXTAREA_CLASS} maxLength={FLOW_LIMITS.paymentDescription} value={step.description} onChange={(e) => onPatch({ description: e.target.value }, 'description')} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="pay-expiry">The link expires after (minutes)</Label>
        <Input
          id="pay-expiry"
          type="number"
          min={FLOW_LIMITS.paymentExpiryMinutesMin}
          max={FLOW_LIMITS.timeoutMinutesMax}
          value={step.expiryMinutes}
          onChange={(e) => {
            const minutes = Number(e.target.value);
            if (Number.isInteger(minutes) && minutes >= FLOW_LIMITS.paymentExpiryMinutesMin && minutes <= FLOW_LIMITS.timeoutMinutesMax) onPatch({ expiryMinutes: minutes }, 'expiryMinutes');
          }}
        />
        <p className="text-xs text-muted-foreground">From 30 minutes to 23 hours, inside the 24-hour reply window.</p>
      </div>
      <GoesToSelect id="pay-next" label="When paid, go to" graph={graph} fromId={step.id} value={step.next} required onChange={(next) => onPatch({ next })} />
      <GoesToSelect id="pay-not-paid" label="When not paid in time, go to" graph={graph} fromId={step.id} value={step.onNotPaid} onChange={(onNotPaid) => onPatch({ onNotPaid })} />
    </div>
  );
}
