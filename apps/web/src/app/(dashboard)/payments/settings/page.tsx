'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMinor, toMinorUnits } from '@wbm/shared';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { paymentsKeys, type PaymentReminder, type PaymentSettings } from '@/lib/payments';
import { usePermissions } from '@/lib/permissions';
import type { Tag, Template } from '@/lib/types';

const ROLES = ['ADMIN', 'MANAGER', 'AGENT'] as const;

/** What a payment template's body variable can show (the `payment` source, or the contact's name). */
const VALUE_CHOICES = [
  { value: 'payment:amount', label: 'Amount' },
  { value: 'payment:description', label: 'What it is for' },
  { value: 'payment:reference', label: 'Reference' },
  { value: 'payment:expires', label: 'Link expiry' },
  { value: 'payment:link', label: 'Pay link address' },
  { value: 'field:name', label: 'Contact name' },
] as const;

/** Body variables of a template (the pay link button is filled with the request's code). */
function bodyVariables(template: Template | undefined): string[] {
  return (template?.variables ?? []).map((v) => v.key).filter((key) => !key.startsWith('BUTTON.'));
}

function MappingFields({ id, template, mapping, onChange, disabled }: { id: string; template: Template | undefined; mapping: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; disabled: boolean }) {
  const keys = bodyVariables(template);
  if (!keys.length) return null;
  return (
    <div className="grid gap-2">
      {keys.map((key) => {
        const current = mapping[key] as { source?: string; key?: string } | undefined;
        const value = current?.source && current.key ? `${current.source}:${current.key}` : '';
        return (
          <div key={key} className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:items-center">
            <Label htmlFor={`${id}-${key}`} className="font-mono text-xs">
              {key}
            </Label>
            <NativeSelect
              id={`${id}-${key}`}
              value={value}
              disabled={disabled}
              onChange={(e) => {
                const [source, field] = e.target.value.split(':');
                const next = { ...mapping };
                if (source && field) next[key] = { source, key: field };
                else delete next[key];
                onChange(next);
              }}
            >
              <option value="">Choose…</option>
              {VALUE_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        );
      })}
    </div>
  );
}

/** Payments > Settings (feature 008, T044): limits, who may ask, the Pay now text and the payment template. */
export default function PaymentSettingsPage() {
  return (
    <RequirePermission permission="payments.view">
      <SettingsForm />
    </RequirePermission>
  );
}

function SettingsForm() {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const editable = can('payments.manage');
  const settings = useQuery({ queryKey: paymentsKeys.settings, queryFn: () => api<PaymentSettings>('/payments/settings') });
  const templates = useQuery({ queryKey: ['templates', { status: 'APPROVED' }], queryFn: () => api<Template[]>('/templates?status=APPROVED') });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api<Tag[]>('/tags') });
  const [draft, setDraft] = useState<PaymentSettings | null>(null);
  const [maxAmount, setMaxAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data && !draft) {
      setDraft(settings.data);
      setMaxAmount(String(settings.data.maxAmountMinor / 100));
    }
  }, [settings.data, draft]);
  const save = useMutation({
    mutationFn: (body: PaymentSettings) =>
      api<PaymentSettings>('/payments/settings', {
        method: 'PUT',
        json: {
          maxAmountMinor: body.maxAmountMinor,
          defaultExpiryMinutes: body.defaultExpiryMinutes,
          requestRoles: body.requestRoles,
          sessionText: body.sessionText,
          buttonText: body.buttonText,
          templateId: body.templateId,
          templateMapping: body.templateMapping,
          reminders: body.reminders,
          chatOrderMode: body.chatOrderMode,
          chatOrderExpiryMinutes: body.chatOrderExpiryMinutes,
          chatOrderTagId: body.chatOrderTagId,
        },
      }),
    onSuccess: (saved) => {
      qc.setQueryData(paymentsKeys.settings, saved);
      setDraft(saved);
      setError(null);
      toast.success('Payment settings saved');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (!draft) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const set = (patch: Partial<PaymentSettings>) => setDraft({ ...draft, ...patch });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ ...draft, maxAmountMinor: toMinorUnits(Number(maxAmount), 'aed') });
  };

  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <Link href="/payments" className="text-sm text-muted-foreground hover:underline">
          ← Payments
        </Link>
        <h1 className="text-2xl font-semibold">Payment settings</h1>
      </div>
      <form onSubmit={submit} className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Requests</CardTitle>
            <CardDescription>The largest amount one request may ask for, the default expiry, and who may ask in live chat.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="max-amount">Largest amount (AED)</Label>
              <Input id="max-amount" type="number" min="2" step="0.01" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} disabled={!editable} />
              <p className="text-xs text-muted-foreground">Now {formatMinor(draft.maxAmountMinor, 'aed')}.</p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="default-expiry">Default expiry (hours)</Label>
              <Input id="default-expiry" type="number" min="1" max="720" value={Math.round(draft.defaultExpiryMinutes / 60)} onChange={(e) => set({ defaultExpiryMinutes: Math.max(30, Number(e.target.value) * 60) })} disabled={!editable} />
            </div>
            <fieldset className="grid gap-1">
              <legend className="text-sm font-medium">Who may request payments</legend>
              {ROLES.map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.requestRoles.includes(role)}
                    disabled={!editable}
                    onChange={(e) => set({ requestRoles: e.target.checked ? [...draft.requestRoles, role] : draft.requestRoles.filter((r) => r !== role) })}
                  />
                  {role.charAt(0) + role.slice(1).toLowerCase()}s
                </label>
              ))}
            </fieldset>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>The Pay now message</CardTitle>
            <CardDescription>Sent inside the 24-hour window. Use {'{description}'}, {'{amount}'}, {'{reference}'} and {'{expires}'}.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="session-text">Message</Label>
              <textarea id="session-text" className="min-h-[96px] rounded-md border bg-background px-3 py-2 text-sm" maxLength={1024} value={draft.sessionText} onChange={(e) => set({ sessionText: e.target.value })} disabled={!editable} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="button-text">Button</Label>
              <Input id="button-text" maxLength={20} value={draft.buttonText} onChange={(e) => set({ buttonText: e.target.value })} disabled={!editable} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Payment template</CardTitle>
            <CardDescription>Used outside the 24-hour window. It needs a website button whose link ends in /p/{'{{1}}'} on the link address.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <NativeSelect aria-label="Payment template" value={draft.templateId ?? ''} onChange={(e) => set({ templateId: e.target.value || null, templateMapping: {} })} disabled={!editable}>
              <option value="">No template (requests outside the window are refused)</option>
              {(templates.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </NativeSelect>
            <MappingFields id="template-map" template={(templates.data ?? []).find((t) => t.id === draft.templateId)} mapping={draft.templateMapping} onChange={(templateMapping) => set({ templateMapping })} disabled={!editable} />
          </CardContent>
        </Card>
        <Card data-testid="chat-order-settings">
          <CardHeader>
            <CardTitle>Carts sent in chat</CardTitle>
            <CardDescription>A cart becomes a chat order. Automatic: the payment link is sent at once when nothing looks wrong. Review: an agent checks it first.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1">
              <Label htmlFor="chat-order-mode">Payment link</Label>
              <NativeSelect id="chat-order-mode" value={draft.chatOrderMode} disabled={!editable} onChange={(e) => set({ chatOrderMode: e.target.value as PaymentSettings['chatOrderMode'] })}>
                <option value="REVIEW">After an agent's review</option>
                <option value="AUTO">Sent automatically</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="chat-order-expiry">Link expires after (hours)</Label>
              <Input id="chat-order-expiry" type="number" min="1" max="720" disabled={!editable} value={Math.round(draft.chatOrderExpiryMinutes / 60)} onChange={(e) => set({ chatOrderExpiryMinutes: Math.max(30, Number(e.target.value) * 60) })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="chat-order-tag">Tag when paid</Label>
              <NativeSelect id="chat-order-tag" value={draft.chatOrderTagId ?? ''} disabled={!editable} onChange={(e) => set({ chatOrderTagId: e.target.value || null })}>
                <option value="">No tag</option>
                {(tags.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="reminders">
          <CardHeader>
            <CardTitle>Reminders</CardTitle>
            <CardDescription>Up to two templates before a waiting request expires, sent only when the request reached the customer. Each template needs the pay link button.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {draft.reminders.map((reminder, i) => {
              const update = (patch: Partial<PaymentReminder>) => set({ reminders: draft.reminders.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
              return (
                <div key={i} className="grid gap-2 rounded-md border p-3" data-testid={`reminder-${i + 1}`}>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-1">
                      <Label htmlFor={`reminder-${i}-hours`}>Hours before the link expires</Label>
                      <Input id={`reminder-${i}-hours`} type="number" min="0.25" step="0.25" value={reminder.beforeMinutes / 60} disabled={!editable} onChange={(e) => update({ beforeMinutes: Math.round(Number(e.target.value) * 60) })} />
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`reminder-${i}-template`}>Template</Label>
                      <NativeSelect id={`reminder-${i}-template`} value={reminder.templateId} disabled={!editable} onChange={(e) => update({ templateId: e.target.value, mapping: {} })}>
                        <option value="">Choose a template…</option>
                        {(templates.data ?? []).map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.language})
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  </div>
                  <MappingFields id={`reminder-${i}-map`} template={(templates.data ?? []).find((t) => t.id === reminder.templateId)} mapping={reminder.mapping ?? {}} onChange={(mapping) => update({ mapping })} disabled={!editable} />
                  {editable ? (
                    <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => set({ reminders: draft.reminders.filter((_, j) => j !== i) })}>
                      Remove reminder
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {editable && draft.reminders.length < 2 ? (
              <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => set({ reminders: [...draft.reminders, { beforeMinutes: draft.reminders.length ? 60 : 240, templateId: '', mapping: {} }] })}>
                Add reminder
              </Button>
            ) : null}
          </CardContent>
        </Card>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {editable ? (
          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
