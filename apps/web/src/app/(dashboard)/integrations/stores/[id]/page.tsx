'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CART_FIELDS, COD_DEFAULTS, ORDER_FIELDS, ORDER_FIELD_LABELS, parseVariableKey } from '@wbm/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { payLinkButtonKey } from '@/components/campaigns/wizard/payment-config';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime, titleCase } from '@/lib/format';
import { growthKeys, type TrackedLinkConfig } from '@/lib/growth';
import {
  AUTOMATION_KIND_LABEL,
  CART_STATUS_LABEL,
  COD_STATUS_LABEL,
  SKIP_REASON_LABEL,
  STORE_PLATFORM_LABEL,
  STORE_STATUS_LABEL,
  type Store,
  type StoreAutomation,
  type StoreAutomationKind,
  type StoreAutomationResults,
  type StoreCartRow,
  type StoreOrderRow,
} from '@/lib/integrations';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Template, WhatsAppNumber } from '@/lib/types';

const STATUS_VARIANT = { CONNECTED: 'success', ERROR: 'warning', DISCONNECTED: 'outline' } as const;
const ORDER_KINDS: StoreAutomationKind[] = ['ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED'];

type Source = { source: 'order'; key: string } | { source: 'field'; key: string } | { source: 'static'; value: string };

/** Integrations > Stores > one store (feature 006 US4, T055): settings, order messages and orders. */
export default function StorePage() {
  return (
    <RequirePermission permission="campaigns.view">
      <StoreView />
    </RequirePermission>
  );
}

function StoreView() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const store = useQuery({ queryKey: ['store', id], queryFn: () => api<Store>(`/stores/${id}`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['store', id] });
  const sync = useMutation({
    mutationFn: () => api(`/stores/${id}/sync`, { method: 'POST' }),
    onSuccess: () => toast.success('Checking the store now'),
    onError: toastError,
  });

  if (store.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (store.error || !store.data) return <p className="text-sm text-destructive">{errorMessage(store.error)}</p>;
  const s = store.data;
  const live = s.status !== 'DISCONNECTED';

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Link href="/integrations/stores" className="text-sm text-muted-foreground hover:underline">
            ← Stores
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{s.name}</h2>
            <Badge data-testid="store-status" variant={STATUS_VARIANT[s.status]}>
              {STORE_STATUS_LABEL[s.status]}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {STORE_PLATFORM_LABEL[s.platform]} · {s.baseUrl} · last event {formatDateTime(s.lastEventAt)} · last check {formatDateTime(s.lastSyncedAt)}
          </p>
          {s.lastError ? <p className="text-sm text-destructive">{s.lastError}</p> : null}
        </div>
        {live ? (
          <Can permission="integrations.manage">
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
                Sync now
              </Button>
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" className="text-destructive">
                    Disconnect
                  </Button>
                }
                title={`Disconnect ${s.name}?`}
                description="Order messages stop and the store's webhooks are removed. Orders and results stay."
                confirmLabel="Disconnect store"
                confirmVariant="destructive"
                onConfirm={() =>
                  api(`/stores/${id}/disconnect`, { method: 'POST' })
                    .then(() => {
                      toast.success('Store disconnected');
                      return refresh();
                    })
                    .catch(toastError)
                }
              />
            </div>
          </Can>
        ) : null}
      </div>

      {live ? (
        <Can permission="integrations.manage">
          <SettingsCard key={`${s.id}-${s.customerTag}-${String(s.consentIsWhatsapp)}`} store={s} onSaved={refresh} />
        </Can>
      ) : null}

      <div className="grid gap-4">
        <h3 className="text-base font-semibold">Order messages</h3>
        {ORDER_KINDS.map((kind) => (
          <AutomationCard key={kind} store={s} kind={kind} />
        ))}
        <h3 className="text-base font-semibold">Cash on delivery</h3>
        <AutomationCard store={s} kind="COD_CONFIRMATION" />
        <h3 className="text-base font-semibold">Abandoned carts</h3>
        <CartCard store={s} />
        <h3 className="text-base font-semibold">Payments</h3>
        <AutomationCard store={s} kind="PAY_LINK" />
      </div>

      <OrdersCard storeId={s.id} />
      <CartsCard storeId={s.id} />
    </div>
  );
}

function SettingsCard({ store, onSaved }: { store: Store; onSaved: () => Promise<unknown> }) {
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const [numberId, setNumberId] = useState(store.numberId);
  const [country, setCountry] = useState(store.defaultCountry);
  const [tag, setTag] = useState(store.customerTag);
  const [consent, setConsent] = useState(store.consentIsWhatsapp);
  const [shipped, setShipped] = useState(store.shippedStatus ?? '');
  const [delivered, setDelivered] = useState(store.deliveredStatus ?? '');
  const save = useMutation({
    mutationFn: () =>
      api<Store>(`/stores/${store.id}`, {
        method: 'PATCH',
        json: {
          numberId,
          defaultCountry: country.trim().toUpperCase(),
          customerTag: tag.trim(),
          consentIsWhatsapp: consent,
          ...(store.platform === 'WOOCOMMERCE' ? { shippedStatus: shipped.trim() || null, deliveredStatus: delivered.trim() || null } : {}),
        },
      }),
    onSuccess: () => {
      toast.success('Settings saved');
      return onSaved();
    },
    onError: toastError,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="st-edit-number">Send from</Label>
            <NativeSelect id="st-edit-number" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              {(numbers.data ?? []).map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} ({n.displayPhoneNumber})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-edit-country">Default country</Label>
            <Input id="st-edit-country" value={country} maxLength={2} className="uppercase" onChange={(e) => setCountry(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-edit-tag">Customer tag</Label>
            <Input id="st-edit-tag" value={tag} maxLength={50} onChange={(e) => setTag(e.target.value)} />
          </div>
        </div>
        {store.platform === 'WOOCOMMERCE' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="st-edit-shipped">Status that means shipped</Label>
              <Input id="st-edit-shipped" value={shipped} placeholder="completed" onChange={(e) => setShipped(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="st-edit-delivered">Status that means delivered</Label>
              <Input id="st-edit-delivered" value={delivered} placeholder="None" onChange={(e) => setDelivered(e.target.value)} />
            </div>
          </div>
        ) : null}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="grid gap-0.5">
            <span>Our checkout&apos;s marketing consent text names WhatsApp</span>
            <span className="text-xs text-muted-foreground">Only then do customers who agree to marketing at checkout count as opted in for WhatsApp.</span>
          </span>
        </label>
        <div>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AutomationCard({ store, kind }: { store: Store; kind: StoreAutomationKind }) {
  const queryClient = useQueryClient();
  const automation = useQuery({ queryKey: ['store-automation', store.id, kind], queryFn: () => api<StoreAutomation>(`/stores/${store.id}/automations/${kind}`) });
  const results = useQuery({ queryKey: ['store-results', store.id, kind], queryFn: () => api<StoreAutomationResults>(`/stores/${store.id}/automations/${kind}/results`) });
  if (!automation.data) return null;
  return (
    <AutomationEditor
      key={JSON.stringify(automation.data)}
      store={store}
      kind={kind}
      automation={automation.data}
      results={results.data}
      onSaved={() => Promise.all([queryClient.invalidateQueries({ queryKey: ['store-automation', store.id, kind] }), queryClient.invalidateQueries({ queryKey: ['store', store.id] })])}
    />
  );
}

function AutomationEditor({
  store,
  kind,
  automation,
  results,
  onSaved,
}: {
  store: Store;
  kind: StoreAutomationKind;
  automation: StoreAutomation;
  results: StoreAutomationResults | undefined;
  onSaved: () => Promise<unknown>;
}) {
  const templates = useQuery({ queryKey: queryKeys.templates({ status: 'APPROVED' }), queryFn: () => api<Template[]>('/templates?status=APPROVED') });
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const step = automation.steps[0];
  const [enabled, setEnabled] = useState(automation.enabled);
  const [templateId, setTemplateId] = useState(step?.templateId ?? '');
  const [mapping, setMapping] = useState<Record<string, Source | undefined>>((step?.variableMapping ?? {}) as Record<string, Source>);
  const waba = (numbers.data ?? []).find((n) => n.id === store.numberId)?.wabaId;
  // COD needs a template whose first two buttons are quick replies: confirm, then cancel.
  const codReady = (t: Template) => {
    const buttons = t.components.find((c) => c.type.toUpperCase() === 'BUTTONS')?.buttons ?? [];
    return buttons.length >= 2 && buttons[0]?.type === 'QUICK_REPLY' && buttons[1]?.type === 'QUICK_REPLY';
  };
  // Feature 008: the pay link template's URL button goes to our pay links and carries the order's code.
  const linkConfig = useQuery({ queryKey: growthKeys.linkConfig, queryFn: () => api<TrackedLinkConfig>('/tracked-links/config'), staleTime: 5 * 60_000, enabled: kind === 'PAY_LINK' });
  const payKeyOf = (t: Template | undefined) => (kind === 'PAY_LINK' ? payLinkButtonKey(t, linkConfig.data?.baseUrl) : null);
  const usable = (templates.data ?? []).filter((t) => (!waba || t.wabaId === waba) && (kind !== 'COD_CONFIRMATION' || codReady(t)) && (kind !== 'PAY_LINK' || payKeyOf(t) !== null));
  const saved = { ...COD_DEFAULTS, ...(automation.settings ?? {}) };
  const [cod, setCod] = useState(saved);
  const savedPay = automation.settings as { includeCod?: boolean; expiryMinutes?: number } | undefined;
  const [payLink, setPayLink] = useState({ includeCod: savedPay?.includeCod ?? false, expiryMinutes: savedPay?.expiryMinutes ?? 1440 });
  const template = usable.find((t) => t.id === templateId);
  const payKey = payKeyOf(template);
  const variables = (template?.variables ?? []).map((v) => v.key).filter((v) => v !== payKey);

  const save = useMutation({
    mutationFn: () =>
      api<StoreAutomation>(`/stores/${store.id}/automations/${kind}`, {
        method: 'PUT',
        json: {
          enabled,
          steps: [{ templateId, variableMapping: Object.fromEntries(variables.flatMap((v) => (mapping[v] ? [[v, mapping[v]]] : []))) }],
          ...(kind === 'COD_CONFIRMATION' ? { settings: { ...cod, reminderMinutes: Number(cod.reminderMinutes), finalMinutes: Number(cod.finalMinutes) } } : {}),
          ...(kind === 'PAY_LINK' ? { settings: { includeCod: payLink.includeCod, expiryMinutes: Number(payLink.expiryMinutes) } } : {}),
        },
      }),
    onSuccess: () => {
      toast.success('Saved');
      return onSaved();
    },
    onError: toastError,
  });

  const counts = results?.counts ?? {};
  const skips = Object.entries(results?.skipReasons ?? {});
  return (
    <Card data-testid={`automation-${kind}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {AUTOMATION_KIND_LABEL[kind]}
          {automation.enabled ? <Badge variant="success">On</Badge> : <Badge variant="outline">Off</Badge>}
        </CardTitle>
        <CardDescription>
          {Number(counts.orders ?? 0)} orders · {Number(counts.sent ?? 0)} sent · {Number(counts.delivered ?? 0)} delivered · {Number(counts.read ?? 0)} read ·{' '}
          {Number(counts.failed ?? 0)} failed · {Number(counts.skipped ?? 0)} skipped
          {skips.length ? ` (${skips.map(([r, n]) => `${SKIP_REASON_LABEL[r] ?? r}: ${n}`).join(', ')})` : ''}
          {kind === 'COD_CONFIRMATION' ? (
            <span data-testid="cod-results" className="block">
              {Number(counts.asked ?? 0)} asked · {Number(counts.confirmed ?? 0)} confirmed · {Number(counts.cancelled ?? 0)} cancelled · {Number(counts.notConfirmed ?? 0)} not confirmed
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <Can permission="campaigns.manage">
        <CardContent className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`tpl-${kind}`}>Template</Label>
            <NativeSelect id={`tpl-${kind}`} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Choose an approved template…</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.language} · {titleCase(t.category)}
                </option>
              ))}
            </NativeSelect>
          </div>
          {variables.map((variable) => {
            const source = mapping[variable];
            const id = `${kind}-${variable.replace(/[^A-Za-z0-9]/g, '-')}`;
            const set = (next: Source | undefined) => setMapping((m) => ({ ...m, [variable]: next }));
            return (
              <div key={variable} data-testid={`map-${kind}-${variable}`} className="grid gap-2 sm:grid-cols-[8rem_12rem_1fr] sm:items-end">
                <div className="font-mono text-sm">{`{{${parseVariableKey(variable)?.placeholder ?? variable}}}`}</div>
                <div className="grid gap-1">
                  <Label htmlFor={`src-${id}`}>Source</Label>
                  <NativeSelect
                    id={`src-${id}`}
                    value={source?.source ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      set(v === 'order' ? { source: 'order', key: 'order_number' } : v === 'field' ? { source: 'field', key: 'name' } : v === 'static' ? { source: 'static', value: '' } : undefined);
                    }}
                  >
                    <option value="">Choose…</option>
                    <option value="order">Order field</option>
                    <option value="field">Contact field</option>
                    <option value="static">Fixed text</option>
                  </NativeSelect>
                </div>
                <div className="grid gap-1">
                  {source?.source === 'order' ? (
                    <>
                      <Label htmlFor={`fld-${id}`}>Order field</Label>
                      <NativeSelect id={`fld-${id}`} value={source.key} onChange={(e) => set({ source: 'order', key: e.target.value })}>
                        {ORDER_FIELDS.map((f) => (
                          <option key={f} value={f}>
                            {ORDER_FIELD_LABELS[f]}
                          </option>
                        ))}
                      </NativeSelect>
                    </>
                  ) : source?.source === 'field' ? (
                    <>
                      <Label htmlFor={`cf-${id}`}>Contact field</Label>
                      <NativeSelect id={`cf-${id}`} value={source.key} onChange={(e) => set({ source: 'field', key: e.target.value })}>
                        <option value="name">Name</option>
                        <option value="phone">Phone</option>
                      </NativeSelect>
                    </>
                  ) : source?.source === 'static' ? (
                    <>
                      <Label htmlFor={`txt-${id}`}>Fixed text</Label>
                      <Input id={`txt-${id}`} value={source.value} onChange={(e) => set({ source: 'static', value: e.target.value })} />
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
          {kind === 'PAY_LINK' ? (
            <div className="grid gap-3 rounded-md border p-3" data-testid="pay-link-settings">
              <p className="text-xs text-muted-foreground">
                Unpaid orders get the template with a Pay now link for the order total (Stripe, in the store&apos;s currency). When the customer pays, the order shows paid here and is marked paid in the store.
              </p>
              {payKey ? <p className="text-xs text-muted-foreground">The {payKey} button carries the order&apos;s own link.</p> : null}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={payLink.includeCod} onChange={(e) => setPayLink((p) => ({ ...p, includeCod: e.target.checked }))} />
                <span className="grid gap-0.5">
                  <span>Also offer cash-on-delivery orders to pay online</span>
                  <span className="text-xs text-muted-foreground">A waiting COD question closes when they pay.</span>
                </span>
              </label>
              <div className="grid gap-1 sm:max-w-xs">
                <Label htmlFor="pay-link-expiry">The link expires after (hours)</Label>
                <Input
                  id="pay-link-expiry"
                  type="number"
                  min={1}
                  max={720}
                  value={Math.round((payLink.expiryMinutes / 60) * 100) / 100}
                  onChange={(e) => {
                    const minutes = Math.round(Number(e.target.value) * 60);
                    if (Number.isFinite(minutes) && minutes >= 30 && minutes <= 43_200) setPayLink((p) => ({ ...p, expiryMinutes: minutes }));
                  }}
                />
              </div>
            </div>
          ) : null}
          {kind === 'COD_CONFIRMATION' ? (
            <div className="grid gap-3 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">The customer taps the first button to confirm and the second to cancel. The first answer counts.</p>
              {(
                [
                  ['confirmedReply', 'Reply when confirmed'],
                  ['cancelledReply', 'Reply when cancelled'],
                  ['alreadyAnsweredReply', 'Reply to a second tap'],
                ] as const
              ).map(([field, label]) => (
                <div key={field} className="grid gap-1">
                  <Label htmlFor={`cod-${field}`}>{label}</Label>
                  <Input id={`cod-${field}`} value={cod[field]} maxLength={1000} onChange={(e) => setCod((c) => ({ ...c, [field]: e.target.value }))} />
                </div>
              ))}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1">
                  <Label htmlFor="cod-reminder">Reminder after (minutes)</Label>
                  <Input id="cod-reminder" type="number" min={30} max={1440} value={cod.reminderMinutes} onChange={(e) => setCod((c) => ({ ...c, reminderMinutes: Number(e.target.value) }))} />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="cod-final">No answer after (minutes)</Label>
                  <Input id="cod-final" type="number" min={60} max={4320} value={cod.finalMinutes} onChange={(e) => setCod((c) => ({ ...c, finalMinutes: Number(e.target.value) }))} />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" checked={cod.autoCancel} onChange={(e) => setCod((c) => ({ ...c, autoCancel: e.target.checked }))} />
                <span className="grid gap-0.5">
                  <span>Cancel the order in the store when the customer cancels</span>
                  <span className="text-xs text-muted-foreground">Off: the order is only tagged, and admins are told to cancel it themselves.</span>
                </span>
              </label>
            </div>
          ) : null}
          {automation.problems.length ? (
            <ul className="list-disc pl-5 text-sm text-destructive">
              {automation.problems.map((p) => (
                <li key={`${p.code}-${p.message}`}>{p.message}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Send this message
            </label>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !templateId}>
              Save
            </Button>
          </div>
        </CardContent>
      </Can>
    </Card>
  );
}

function OrdersCard({ storeId }: { storeId: string }) {
  const [codStatus, setCodStatus] = useState('');
  const orders = useQuery({
    queryKey: ['store-orders', storeId, codStatus],
    queryFn: () => api<{ items: StoreOrderRow[]; total: number }>(`/stores/${storeId}/orders?pageSize=50${codStatus ? `&codStatus=${codStatus}` : ''}`),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Orders</CardTitle>
        <CardDescription>{orders.data ? `${orders.data.total} orders seen` : 'Orders the store reported'}</CardDescription>
        <div className="max-w-xs">
          <Label htmlFor="orders-cod" className="sr-only">
            COD status
          </Label>
          <NativeSelect id="orders-cod" value={codStatus} onChange={(e) => setCodStatus(e.target.value)}>
            <option value="">All orders</option>
            {(['ASKED', 'CONFIRMED', 'CANCELLED', 'NO_ANSWER', 'CLOSED'] as const).map((st) => (
              <option key={st} value={st}>
                COD: {COD_STATUS_LABEL[st]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {!orders.data?.items.length ? (
          <p className="p-6 text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>COD</TableHead>
                <TableHead>Messages</TableHead>
                <TableHead>Placed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.data.items.map((o) => (
                <TableRow key={o.id} data-testid="store-order-row">
                  <TableCell className="font-medium">{o.orderNumber}</TableCell>
                  <TableCell className="text-sm">
                    {o.contact ? (
                      <Link href={`/contacts/${o.contact.id}`} className="hover:underline">
                        {o.contact.name ?? o.contact.phone}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">No phone</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {o.total} {o.currency}
                  </TableCell>
                  <TableCell data-testid="order-payment">
                    {titleCase(o.paymentKind)}
                    {o.paidViaLinkAt ? (
                      <Badge variant="success" className="ml-1">
                        Paid via link
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs" data-testid="order-cod">
                    {COD_STATUS_LABEL[o.codStatus]}
                  </TableCell>
                  <TableCell className="text-xs">
                    {o.messages.length
                      ? o.messages.map((m) => (
                          <div key={m.kind}>
                            {AUTOMATION_KIND_LABEL[m.kind as StoreAutomationKind] ?? m.kind}:{' '}
                            {m.outcome === 'QUEUED' ? titleCase(m.status ?? 'queued') : `skipped (${SKIP_REASON_LABEL[m.skipReason ?? ''] ?? m.skipReason})`}
                          </div>
                        ))
                      : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(o.placedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const CART_FIELD_LABELS: Record<(typeof CART_FIELDS)[number], string> = {
  first_name: 'Customer first name',
  customer_name: 'Customer name',
  items: 'Items',
  total: 'Cart total',
  cart_url: 'Cart link (tracked)',
  store_name: 'Store name',
};

interface CartStepDraft {
  templateId: string;
  waitMinutes: number;
  mapping: Record<string, Source | undefined>;
}

/** Up to three marketing reminders with increasing waits (US6). */
function CartCard({ store }: { store: Store }) {
  const queryClient = useQueryClient();
  const automation = useQuery({ queryKey: ['store-automation', store.id, 'CART_REMINDER'], queryFn: () => api<StoreAutomation>(`/stores/${store.id}/automations/CART_REMINDER`) });
  const results = useQuery({ queryKey: ['store-results', store.id, 'CART_REMINDER'], queryFn: () => api<StoreAutomationResults>(`/stores/${store.id}/automations/CART_REMINDER/results`) });
  if (!automation.data) return null;
  return (
    <CartEditor
      key={JSON.stringify(automation.data)}
      store={store}
      automation={automation.data}
      results={results.data}
      onSaved={() => Promise.all([queryClient.invalidateQueries({ queryKey: ['store-automation', store.id, 'CART_REMINDER'] }), queryClient.invalidateQueries({ queryKey: ['store', store.id] })])}
    />
  );
}

function CartEditor({ store, automation, results, onSaved }: { store: Store; automation: StoreAutomation; results: StoreAutomationResults | undefined; onSaved: () => Promise<unknown> }) {
  const templates = useQuery({ queryKey: queryKeys.templates({ status: 'APPROVED' }), queryFn: () => api<Template[]>('/templates?status=APPROVED') });
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const waba = (numbers.data ?? []).find((n) => n.id === store.numberId)?.wabaId;
  const usable = (templates.data ?? []).filter((t) => (!waba || t.wabaId === waba) && t.category === 'MARKETING');
  const [enabled, setEnabled] = useState(automation.enabled);
  const [steps, setSteps] = useState<CartStepDraft[]>(
    automation.steps.length
      ? automation.steps.map((s) => ({ templateId: s.templateId, waitMinutes: s.waitMinutes ?? 60, mapping: s.variableMapping as Record<string, Source> }))
      : [{ templateId: '', waitMinutes: 60, mapping: {} }],
  );
  const save = useMutation({
    mutationFn: () =>
      api<StoreAutomation>(`/stores/${store.id}/automations/CART_REMINDER`, {
        method: 'PUT',
        json: {
          enabled,
          steps: steps.map((s) => {
            const variables = (usable.find((t) => t.id === s.templateId)?.variables ?? []).map((v) => v.key);
            return { templateId: s.templateId, waitMinutes: Number(s.waitMinutes), variableMapping: Object.fromEntries(variables.flatMap((v) => (s.mapping[v] ? [[v, s.mapping[v]]] : []))) };
          }),
        },
      }),
    onSuccess: () => {
      toast.success('Saved');
      return onSaved();
    },
    onError: toastError,
  });
  const update = (index: number, patch: Partial<CartStepDraft>) => setSteps((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const counts = results?.counts ?? {};
  const perStep = (counts.perStep ?? {}) as unknown as Record<string, number>;
  const skips = Object.entries(results?.skipReasons ?? {});

  return (
    <Card data-testid="automation-CART_REMINDER">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {AUTOMATION_KIND_LABEL.CART_REMINDER}
          {automation.enabled ? <Badge variant="success">On</Badge> : <Badge variant="outline">Off</Badge>}
        </CardTitle>
        <CardDescription>
          <span data-testid="cart-results">
            {Number(counts.carts ?? 0)} carts · reminders sent {[1, 2, 3].map((n) => perStep[String(n)] ?? 0).join(' / ')} · {Number(counts.clicks ?? 0)} clicks · {Number(counts.recovered ?? 0)} recovered (
            {String(counts.recoveredValue ?? '0')})
          </span>
          {skips.length ? ` · ${skips.map(([r, n]) => `${SKIP_REASON_LABEL[r] ?? r}: ${n}`).join(', ')}` : ''}
        </CardDescription>
      </CardHeader>
      <Can permission="campaigns.manage">
        <CardContent className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            Cart reminders are marketing messages: use Marketing templates. They go only to contacts who opted in.{' '}
            {store.consentIsWhatsapp
              ? 'Customers who agree to marketing at checkout count as opted in.'
              : 'Checkout consent does not count yet: confirm that your checkout consent text names WhatsApp in Settings above.'}
          </p>
          {steps.map((step, index) => {
            const template = usable.find((t) => t.id === step.templateId);
            const variables = (template?.variables ?? []).map((v) => v.key);
            return (
              <div key={index} data-testid={`cart-step-${index + 1}`} className="grid gap-2 rounded-md border p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
                  <div className="grid gap-1">
                    <Label htmlFor={`cart-tpl-${index}`}>Reminder {index + 1} template</Label>
                    <NativeSelect id={`cart-tpl-${index}`} value={step.templateId} onChange={(e) => update(index, { templateId: e.target.value, mapping: {} })}>
                      <option value="">Choose a Marketing template…</option>
                      {usable.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {t.language}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`cart-wait-${index}`}>Minutes after the cart</Label>
                    <Input id={`cart-wait-${index}`} type="number" min={30} max={10080} value={step.waitMinutes} onChange={(e) => update(index, { waitMinutes: Number(e.target.value) })} />
                  </div>
                  {steps.length > 1 ? (
                    <Button type="button" variant="ghost" onClick={() => setSteps((all) => all.filter((_, i) => i !== index))}>
                      Remove
                    </Button>
                  ) : null}
                </div>
                {variables.map((variable) => {
                  const source = step.mapping[variable];
                  const id = `cart-${index}-${variable.replace(/[^A-Za-z0-9]/g, '-')}`;
                  const set = (next: Source | undefined) => update(index, { mapping: { ...step.mapping, [variable]: next } });
                  return (
                    <div key={variable} data-testid={`cart-map-${index + 1}-${variable}`} className="grid gap-2 sm:grid-cols-[8rem_12rem_1fr] sm:items-end">
                      <div className="font-mono text-sm">{`{{${parseVariableKey(variable)?.placeholder ?? variable}}}`}</div>
                      <div className="grid gap-1">
                        <Label htmlFor={`src-${id}`}>Source</Label>
                        <NativeSelect
                          id={`src-${id}`}
                          value={source?.source ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            set(v === 'order' ? { source: 'order', key: 'cart_url' } : v === 'field' ? { source: 'field', key: 'name' } : v === 'static' ? { source: 'static', value: '' } : undefined);
                          }}
                        >
                          <option value="">Choose…</option>
                          <option value="order">Cart field</option>
                          <option value="field">Contact field</option>
                          <option value="static">Fixed text</option>
                        </NativeSelect>
                      </div>
                      <div className="grid gap-1">
                        {source?.source === 'order' ? (
                          <>
                            <Label htmlFor={`fld-${id}`}>Cart field</Label>
                            <NativeSelect id={`fld-${id}`} value={source.key} onChange={(e) => set({ source: 'order', key: e.target.value })}>
                              {CART_FIELDS.map((f) => (
                                <option key={f} value={f}>
                                  {CART_FIELD_LABELS[f]}
                                </option>
                              ))}
                            </NativeSelect>
                          </>
                        ) : source?.source === 'field' ? (
                          <>
                            <Label htmlFor={`cf-${id}`}>Contact field</Label>
                            <NativeSelect id={`cf-${id}`} value={source.key} onChange={(e) => set({ source: 'field', key: e.target.value })}>
                              <option value="name">Name</option>
                              <option value="phone">Phone</option>
                            </NativeSelect>
                          </>
                        ) : source?.source === 'static' ? (
                          <>
                            <Label htmlFor={`txt-${id}`}>Fixed text</Label>
                            <Input id={`txt-${id}`} value={source.value} onChange={(e) => set({ source: 'static', value: e.target.value })} />
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {steps.length < 3 ? (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setSteps((all) => [...all, { templateId: '', waitMinutes: (all[all.length - 1]?.waitMinutes ?? 60) * 2, mapping: {} }])}>
                Add a reminder
              </Button>
            </div>
          ) : null}
          {automation.problems.length ? (
            <ul className="list-disc pl-5 text-sm text-destructive">
              {automation.problems.map((p) => (
                <li key={`${p.code}-${p.message}`}>{p.message}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Send cart reminders
            </label>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || steps.some((s) => !s.templateId)}>
              Save
            </Button>
          </div>
        </CardContent>
      </Can>
    </Card>
  );
}

function CartsCard({ storeId }: { storeId: string }) {
  const carts = useQuery({ queryKey: ['store-carts', storeId], queryFn: () => api<{ items: StoreCartRow[]; total: number }>(`/stores/${storeId}/carts?pageSize=50`) });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Carts</CardTitle>
        <CardDescription>{carts.data ? `${carts.data.total} carts` : 'Checkouts left without an order'}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!carts.data?.items.length ? (
          <p className="p-6 text-sm text-muted-foreground">No carts yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reminders</TableHead>
                <TableHead>Recovered</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {carts.data.items.map((c) => (
                <TableRow key={c.id} data-testid="store-cart-row">
                  <TableCell className="text-sm">{c.contact ? (c.contact.name ?? c.contact.phone) : <span className="text-muted-foreground">No phone</span>}</TableCell>
                  <TableCell className="tabular-nums">
                    {c.value} {c.currency}
                  </TableCell>
                  <TableCell className="text-xs">
                    {CART_STATUS_LABEL[c.status]}
                    {c.stopReason ? ` (${SKIP_REASON_LABEL[c.stopReason] ?? c.stopReason})` : ''}
                  </TableCell>
                  <TableCell className="tabular-nums">{c.remindersSent}</TableCell>
                  <TableCell className="tabular-nums">{c.recoveredValue ? `${c.recoveredValue} ${c.currency}` : '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(c.startedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
