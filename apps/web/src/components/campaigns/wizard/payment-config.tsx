'use client';

import { useQuery } from '@tanstack/react-query';
import { payLinkButtonIndex } from '@wbm/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { flowKeys, type FlowSummary } from '@/lib/flows';
import { queryKeys } from '@/lib/query';
import type { CampaignPaymentConfig, Tag, Template } from '@/lib/types';

/** The `payment` variable source's keys (feature 008): what a body variable can show. */
export const PAYMENT_VARIABLE_KEYS: Array<{ key: string; label: string }> = [
  { key: 'amount', label: 'Amount' },
  { key: 'description', label: 'What it is for' },
  { key: 'expires', label: 'Link expiry' },
  { key: 'link', label: 'Pay link address' },
];

export const DEFAULT_PAYMENT_CONFIG: CampaignPaymentConfig = { amount: { source: 'static', minor: 10_000 }, description: '', expiryMinutes: 1440, tagId: null, flowId: null };

/** The template's pay link button variable (BUTTON.n.1), when its URL button goes to our pay links. */
export function payLinkButtonKey(template: Template | undefined, linkBase: string | null | undefined): string | null {
  const buttons = (template?.components.find((c) => c.type.toUpperCase() === 'BUTTONS') as unknown as { buttons?: Array<{ type: string; url?: string }> } | undefined)?.buttons ?? [];
  const index = payLinkButtonIndex(buttons as never, linkBase);
  return index < 0 ? null : `BUTTON.${index}.1`;
}

export function paymentConfigComplete(config: CampaignPaymentConfig | null): boolean {
  if (!config) return true;
  const amountOk = config.amount.source === 'static' ? config.amount.minor >= 1 : config.amount.attributeKey.trim().length > 0;
  return amountOk && config.description.trim().length > 0 && config.expiryMinutes >= 30 && config.expiryMinutes <= 43_200;
}

/**
 * Ask every recipient to pay (feature 008 US3, FR-009): each gets their own request and pay link in
 * the template's pay link button; the amount is fixed or read from a number attribute.
 */
export function PaymentConfigCard({ value, onChange }: { value: CampaignPaymentConfig | null; onChange: (next: CampaignPaymentConfig | null) => void }) {
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags'), enabled: Boolean(value) });
  const flows = useQuery({ queryKey: flowKeys.list, queryFn: () => api<FlowSummary[]>('/flows'), enabled: Boolean(value) });
  const set = (patch: Partial<CampaignPaymentConfig>) => value && onChange({ ...value, ...patch });

  return (
    <section aria-labelledby="pay-config-title" className="grid gap-3 rounded-md border p-4" data-testid="payment-config">
      <label className="flex items-center gap-2 text-sm font-medium" id="pay-config-title">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked ? DEFAULT_PAYMENT_CONFIG : null)} />
        Ask each recipient to pay
      </label>
      <p className="text-xs text-muted-foreground">The template&apos;s pay link button gets each recipient&apos;s own link. Recipients without an amount are held back.</p>
      {value ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="pay-amount-source">Amount</Label>
            <NativeSelect
              id="pay-amount-source"
              value={value.amount.source}
              onChange={(e) => set({ amount: e.target.value === 'static' ? { source: 'static', minor: 10_000 } : { source: 'attribute', attributeKey: '' } })}
            >
              <option value="static">The same for everyone</option>
              <option value="attribute">From a number attribute</option>
            </NativeSelect>
          </div>
          {value.amount.source === 'static' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="pay-amount-value">Amount (AED)</Label>
              <Input
                id="pay-amount-value"
                type="number"
                min="2"
                step="0.01"
                value={value.amount.minor / 100}
                onChange={(e) => {
                  const minor = Math.round(Number(e.target.value) * 100);
                  if (Number.isFinite(minor) && minor >= 1) set({ amount: { source: 'static', minor } });
                }}
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="pay-amount-attribute">Attribute key</Label>
              <Input id="pay-amount-attribute" value={value.amount.attributeKey} placeholder="balance" onChange={(e) => set({ amount: { source: 'attribute', attributeKey: e.target.value.trim() } })} />
            </div>
          )}
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="pay-description">What it is for</Label>
            <Input id="pay-description" maxLength={250} value={value.description} placeholder="Invoice for {name}" onChange={(e) => set({ description: e.target.value })} />
            <p className="text-xs text-muted-foreground">{'{name}'} and {'{attr:key}'} are filled for each recipient.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-expiry-hours">The link expires after (hours)</Label>
            <Input
              id="pay-expiry-hours"
              type="number"
              min="1"
              max="720"
              value={Math.round((value.expiryMinutes / 60) * 100) / 100}
              onChange={(e) => {
                const minutes = Math.round(Number(e.target.value) * 60);
                if (Number.isFinite(minutes) && minutes >= 30 && minutes <= 43_200) set({ expiryMinutes: minutes });
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-tag">When paid, add the tag</Label>
            <NativeSelect id="pay-tag" value={value.tagId ?? ''} onChange={(e) => set({ tagId: e.target.value || null })}>
              <option value="">No tag</option>
              {(tags.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-flow">When paid, start the flow</Label>
            <NativeSelect id="pay-flow" value={value.flowId ?? ''} onChange={(e) => set({ flowId: e.target.value || null })}>
              <option value="">No flow</option>
              {(flows.data ?? [])
                .filter((f) => f.status === 'PUBLISHED' || f.id === value.flowId)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </NativeSelect>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** One line for the review step. */
export function paymentConfigSummary(config: CampaignPaymentConfig, names: { tag?: string | null; flow?: string | null } = {}): string {
  const amount = config.amount.source === 'static' ? `AED ${(config.amount.minor / 100).toFixed(2)}` : `the ${config.amount.attributeKey} attribute`;
  const hours = Math.round((config.expiryMinutes / 60) * 10) / 10;
  const after = [names.tag ? `tag ${names.tag}` : '', names.flow ? `flow ${names.flow}` : ''].filter(Boolean).join(' and ');
  return `Each recipient is asked to pay ${amount} for “${config.description}”; the link expires after ${hours} hour${hours === 1 ? '' : 's'}${after ? `; when paid: ${after}` : ''}.`;
}
