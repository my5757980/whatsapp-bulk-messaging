'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COD_DEFAULTS, ORDER_FIELDS, ORDER_FIELD_LABELS, parseVariableKey } from '@wbm/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
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
import {
  AUTOMATION_KIND_LABEL,
  COD_STATUS_LABEL,
  SKIP_REASON_LABEL,
  STORE_PLATFORM_LABEL,
  STORE_STATUS_LABEL,
  type Store,
  type StoreAutomation,
  type StoreAutomationKind,
  type StoreAutomationResults,
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
      </div>

      <OrdersCard storeId={s.id} />
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
  const usable = (templates.data ?? []).filter((t) => (!waba || t.wabaId === waba) && (kind !== 'COD_CONFIRMATION' || codReady(t)));
  const saved = { ...COD_DEFAULTS, ...(automation.settings ?? {}) };
  const [cod, setCod] = useState(saved);
  const template = usable.find((t) => t.id === templateId);
  const variables = (template?.variables ?? []).map((v) => v.key);

  const save = useMutation({
    mutationFn: () =>
      api<StoreAutomation>(`/stores/${store.id}/automations/${kind}`, {
        method: 'PUT',
        json: {
          enabled,
          steps: [{ templateId, variableMapping: Object.fromEntries(variables.flatMap((v) => (mapping[v] ? [[v, mapping[v]]] : []))) }],
          ...(kind === 'COD_CONFIRMATION' ? { settings: { ...cod, reminderMinutes: Number(cod.reminderMinutes), finalMinutes: Number(cod.finalMinutes) } } : {}),
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
                  <TableCell>{titleCase(o.paymentKind)}</TableCell>
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
