'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { STORE_PLATFORM_LABEL, STORE_STATUS_LABEL, type Store, type StorePlatform } from '@/lib/integrations';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { WhatsAppNumber } from '@/lib/types';

const STATUS_VARIANT = { CONNECTED: 'success', ERROR: 'warning', DISCONNECTED: 'outline' } as const;

/** Integrations > Stores (feature 006 US4, T055): connected Shopify and WooCommerce stores. */
export default function StoresPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <StoreList />
    </RequirePermission>
  );
}

function StoreList() {
  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api<Store[]>('/stores') });
  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Stores</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Connect your Shopify or WooCommerce store to send order updates, confirm cash-on-delivery orders and remind customers about carts they left.
          </p>
        </div>
        <Can permission="integrations.manage">
          <ConnectStoreDialog />
        </Can>
      </div>
      <Card>
        <CardContent className="p-0">
          {stores.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : stores.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(stores.error)}</p>
          ) : !stores.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No stores yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Messages on</TableHead>
                  <TableHead>Last event</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stores.data.map((s) => (
                  <TableRow key={s.id} data-testid="store-row">
                    <TableCell>
                      <Link href={`/integrations/stores/${s.id}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{s.baseUrl}</div>
                    </TableCell>
                    <TableCell>{STORE_PLATFORM_LABEL[s.platform]}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[s.status]}>{STORE_STATUS_LABEL[s.status]}</Badge>
                    </TableCell>
                    <TableCell>{s.automations.filter((a) => a.enabled).length}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(s.lastEventAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const STEPS: Record<StorePlatform, string[]> = {
  SHOPIFY: [
    'In the Shopify Dev Dashboard, create an app in the same organization as your store.',
    'Give it the Admin API scopes read_orders, write_orders and read_customers, and declare the customer data it reads (name, phone, address).',
    'Install it on your store, then copy its client ID and client secret here.',
  ],
  WOOCOMMERCE: [
    'In WordPress, open WooCommerce → Settings → Advanced → REST API and add a key.',
    'Choose an administrator user and Read/Write permissions.',
    'Copy the consumer key (ck_…) and consumer secret (cs_…) here. Your site must use https.',
  ],
};

function ConnectStoreDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<StorePlatform>('SHOPIFY');
  const [legacy, setLegacy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers'), enabled: open });
  const connected = (numbers.data ?? []).filter((n) => n.connectionStatus === 'CONNECTED');

  const connect = useMutation({
    mutationFn: (body: unknown) => api<Store>('/stores', { method: 'POST', json: body }),
    onSuccess: (store) => router.push(`/integrations/stores/${store.id}`),
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const credentials =
      platform === 'SHOPIFY'
        ? legacy
          ? { accessToken: text('accessToken'), clientSecret: text('clientSecret') }
          : { clientId: text('clientId'), clientSecret: text('clientSecret') }
        : { consumerKey: text('consumerKey'), consumerSecret: text('consumerSecret') };
    connect.mutate({ platform, baseUrl: text('baseUrl'), numberId: text('numberId'), defaultCountry: text('defaultCountry').toUpperCase(), customerTag: text('customerTag'), credentials });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>Connect a store</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect a store</DialogTitle>
          <DialogDescription>We test the access and set up the store&apos;s webhooks for you. The keys are stored encrypted and never shown again.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="st-platform">Platform</Label>
            <NativeSelect id="st-platform" value={platform} onChange={(e) => setPlatform(e.target.value as StorePlatform)}>
              <option value="SHOPIFY">Shopify</option>
              <option value="WOOCOMMERCE">WooCommerce</option>
            </NativeSelect>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            {STEPS[platform].map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="grid gap-1.5">
            <Label htmlFor="st-url">Store address</Label>
            <Input id="st-url" name="baseUrl" required placeholder={platform === 'SHOPIFY' ? 'https://your-shop.myshopify.com' : 'https://shop.example.com'} />
          </div>
          {platform === 'SHOPIFY' ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={legacy} onChange={(e) => setLegacy(e.target.checked)} />
                Use a legacy custom app&apos;s access token instead
              </label>
              {legacy ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="st-token">Access token</Label>
                  <Input id="st-token" name="accessToken" required autoComplete="off" />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="st-client-id">Client ID</Label>
                  <Input id="st-client-id" name="clientId" required autoComplete="off" />
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="st-client-secret">Client secret</Label>
                <Input id="st-client-secret" name="clientSecret" type="password" required autoComplete="off" />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="st-ck">Consumer key</Label>
                <Input id="st-ck" name="consumerKey" required autoComplete="off" placeholder="ck_…" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="st-cs">Consumer secret</Label>
                <Input id="st-cs" name="consumerSecret" type="password" required autoComplete="off" placeholder="cs_…" />
              </div>
            </>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="st-number">Send from</Label>
            <NativeSelect id="st-number" name="numberId" required defaultValue="">
              <option value="">Choose a connected number…</option>
              {connected.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} ({n.displayPhoneNumber})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="st-country">Default country</Label>
              <Input id="st-country" name="defaultCountry" required maxLength={2} defaultValue="AE" className="uppercase" />
              <p className="text-xs text-muted-foreground">For phone numbers without a country code.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="st-tag">Customer tag</Label>
              <Input key={platform} id="st-tag" name="customerTag" required maxLength={50} defaultValue={platform === 'SHOPIFY' ? 'shopify' : 'woocommerce'} />
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? 'Connecting…' : 'Connect store'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
