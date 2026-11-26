'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMinor } from '@wbm/shared';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { NOT_SENDABLE_LABEL, catalogKeys, type CatalogConnection, type CatalogProduct, type CatalogState, type CommerceNumber } from '@/lib/catalog';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import type { Store } from '@/lib/integrations';

/** The Meta catalog (feature 008 US5, FR-021 – FR-025): connect it, copy the products, numbers' settings, store fill and search. */
export default function CatalogPage() {
  return (
    <RequirePermission permission="integrations.manage">
      <Catalog />
    </RequirePermission>
  );
}

function Catalog() {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: catalogKeys.state, queryFn: () => api<CatalogState>('/catalog/connection'), refetchInterval: (q) => (q.state.data?.connection?.syncStatus === 'RUNNING' ? 5_000 : false) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['catalog'] });
  const connect = useMutation({
    mutationFn: (catalogId: string) => api<CatalogConnection>('/catalog/connection', { method: 'POST', json: { catalogId } }),
    onSuccess: () => {
      toast.success('Catalog connected; copying the products');
      return refresh();
    },
    onError: toastError,
  });
  const disconnect = useMutation({
    mutationFn: () => api('/catalog/connection', { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Catalog disconnected');
      return refresh();
    },
    onError: toastError,
  });
  const sync = useMutation({
    mutationFn: () => api('/catalog/sync', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Copying the products');
      return refresh();
    },
    onError: toastError,
  });
  if (state.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const data = state.data;
  if (!data) return null;
  const connection = data.connection;

  return (
    <div className="grid max-w-5xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Catalog</h1>
        <p className="text-sm text-muted-foreground">The Meta catalog of your WhatsApp Business Accounts: products agents can send, carts and catalog templates.</p>
      </div>

      <Card data-testid="catalog-connection">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {connection ? connection.name : 'Not connected'}
            {connection ? <Badge variant={connection.syncStatus === 'FAILED' ? 'destructive' : connection.syncStatus === 'RUNNING' ? 'warning' : 'success'}>{connection.syncStatus === 'RUNNING' ? 'Copying' : connection.syncStatus === 'FAILED' ? 'Copy failed' : 'Connected'}</Badge> : null}
          </CardTitle>
          <CardDescription>
            {connection
              ? `${connection.productCount} products · last copied ${connection.lastSyncedAt ? formatDateTime(connection.lastSyncedAt) : 'not yet'} · copied again every hour`
              : 'Connect the catalog that Commerce Manager links to your WhatsApp Business Account.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {connection?.lastSyncError ? (
            <p role="alert" className="text-sm text-destructive">
              {connection.lastSyncError}
            </p>
          ) : null}
          {connection ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending || connection.syncStatus === 'RUNNING'}>
                Copy products now
              </Button>
              <ConfirmDialog
                title="Disconnect the catalog?"
                description="Agents can no longer send products. The copy is kept for 90 days."
                confirmLabel="Disconnect"
                onConfirm={() => disconnect.mutateAsync().then(() => undefined)}
                trigger={
                  <Button size="sm" variant="outline">
                    Disconnect
                  </Button>
                }
              />
            </div>
          ) : (
            <ul className="grid gap-2" aria-label="Catalogs found">
              {data.found.flatMap((f) =>
                f.catalogs.map((c) => (
                  <li key={`${f.wabaId}-${c.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                    <span>
                      {c.name} <span className="text-xs text-muted-foreground">({c.id}, account {f.wabaId})</span>
                    </span>
                    <Button size="sm" onClick={() => connect.mutate(c.id)} disabled={connect.isPending}>
                      Connect
                    </Button>
                  </li>
                )),
              )}
              {!data.found.some((f) => f.catalogs.length) ? <li className="text-sm text-muted-foreground">No catalog is linked to your WhatsApp accounts yet. Link one in Meta Commerce Manager.</li> : null}
            </ul>
          )}
        </CardContent>
      </Card>

      {connection ? <NumbersCard numbers={data.numbers} /> : null}
      {connection ? <FillCard connection={connection} /> : null}
      {connection ? <ProductsCard /> : null}
    </div>
  );
}

function NumbersCard({ numbers }: { numbers: CommerceNumber[] }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (input: { numberId: string; cartEnabled: boolean; catalogVisible: boolean }) =>
      api<CommerceNumber>(`/catalog/numbers/${input.numberId}/commerce-settings`, { method: 'PUT', json: { cartEnabled: input.cartEnabled, catalogVisible: input.catalogVisible } }),
    onSuccess: () => {
      toast.success('Saved');
      return queryClient.invalidateQueries({ queryKey: catalogKeys.state });
    },
    onError: toastError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Numbers</CardTitle>
        <CardDescription>The cart lets customers send orders in chat; the catalog button shows the catalog in the chat header.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm" data-testid="commerce-numbers">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">Number</th>
              <th className="p-2">Catalog</th>
              <th className="p-2">Cart</th>
              <th className="p-2">Catalog button</th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => (
              <tr key={n.numberId} className="border-t">
                <td className="p-2">{n.phone}</td>
                <td className="p-2">{n.catalogConnected ? 'Linked' : <span className="text-muted-foreground">Not linked to this account</span>}</td>
                <td className="p-2">
                  <input
                    type="checkbox"
                    aria-label={`Cart for ${n.phone}`}
                    disabled={!n.catalogConnected || save.isPending}
                    checked={n.cartEnabled ?? false}
                    onChange={(e) => save.mutate({ numberId: n.numberId, cartEnabled: e.target.checked, catalogVisible: n.catalogVisible ?? false })}
                  />
                </td>
                <td className="p-2">
                  <input
                    type="checkbox"
                    aria-label={`Catalog button for ${n.phone}`}
                    disabled={!n.catalogConnected || save.isPending}
                    checked={n.catalogVisible ?? false}
                    onChange={(e) => save.mutate({ numberId: n.numberId, cartEnabled: n.cartEnabled ?? false, catalogVisible: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function FillCard({ connection }: { connection: CatalogConnection }) {
  const queryClient = useQueryClient();
  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api<Store[]>('/stores') });
  const [storeId, setStoreId] = useState(connection.fillStoreId ?? '');
  const save = useMutation({
    mutationFn: (enabled: boolean) => api<CatalogConnection>('/catalog/fill', { method: 'PUT', json: { enabled, storeId: storeId || null } }),
    onSuccess: (_row, enabled) => {
      toast.success(enabled ? 'The catalog is filled from the store every hour' : 'Filling turned off');
      return queryClient.invalidateQueries({ queryKey: catalogKeys.state });
    },
    onError: toastError,
  });
  const run = useMutation({
    mutationFn: () => api('/catalog/fill/run', { method: 'POST' }),
    onSuccess: () => toast.success('Filling from the store'),
    onError: toastError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Fill from a store</CardTitle>
        <CardDescription>
          {connection.fillEnabled ? `On · last filled ${connection.lastFilledAt ? formatDateTime(connection.lastFilledAt) : 'not yet'}` : 'Off: products come only from Commerce Manager.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1 sm:max-w-sm">
          <Label htmlFor="fill-store">Store</Label>
          <NativeSelect id="fill-store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">Choose a store…</option>
            {(stores.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-wrap gap-2">
          {connection.fillEnabled ? (
            <>
              <Button size="sm" variant="outline" onClick={() => run.mutate()} disabled={run.isPending}>
                Fill now
              </Button>
              <Button size="sm" variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending}>
                Turn off
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => save.mutate(true)} disabled={!storeId || save.isPending}>
              Fill every hour
            </Button>
          )}
        </div>
        {connection.fillErrors.length ? (
          <ul className="grid gap-1 text-sm text-destructive" aria-label="Fill errors">
            {connection.fillErrors.map((e, i) => (
              <li key={`${e.retailerId ?? ''}-${i}`}>
                {e.retailerId ? `${e.retailerId}: ` : ''}
                {e.message}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ProductsCard() {
  const [search, setSearch] = useState('');
  const [sendable, setSendable] = useState(false);
  const products = useQuery({
    queryKey: catalogKeys.products(search, 1, sendable),
    queryFn: () => api<{ items: CatalogProduct[]; total: number }>(`/catalog/products?pageSize=100${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}${sendable ? '&sendable=true' : ''}`),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Products</CardTitle>
        <CardDescription>{products.data ? `${products.data.total} found` : ' '}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input aria-label="Search products" placeholder="Search by name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} className="sm:max-w-xs" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sendable} onChange={(e) => setSendable(e.target.checked)} />
            Only products that can be sent
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="catalog-products">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Product</th>
                <th className="p-2">SKU</th>
                <th className="p-2">Price</th>
                <th className="p-2">Can be sent</th>
              </tr>
            </thead>
            <tbody>
              {(products.data?.items ?? []).map((p) => (
                <tr key={p.retailerId} className="border-t">
                  <td className="p-2">{p.name}</td>
                  <td className="p-2 font-mono text-xs">{p.retailerId}</td>
                  <td className="p-2 tabular-nums">{(p.salePriceMinor ?? p.priceMinor) !== null && p.currency ? formatMinor((p.salePriceMinor ?? p.priceMinor)!, p.currency) : '—'}</td>
                  <td className="p-2">{p.sendable ? 'Yes' : <span className="text-destructive">{p.notSendableReason ? NOT_SENDABLE_LABEL[p.notSendableReason] : 'No'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
