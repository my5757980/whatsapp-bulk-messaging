'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { GATEWAY_CHECK_LABEL, paymentsKeys, type GatewayCheck, type PaymentGateway } from '@/lib/payments';
import { usePermissions } from '@/lib/permissions';

const RESULT_VARIANT = { PASSED: 'success', WARNING: 'warning', FAILED: 'destructive' } as const;
const RESULT_LABEL = { PASSED: 'Passed', WARNING: 'Warning', FAILED: 'Failed' } as const;

/** Payments > Gateway (feature 008 US1, T029): the Stripe key and checks, then the connection card. */
export default function PaymentsGatewayPage() {
  return (
    <RequirePermission permission="payments.view">
      <Gateway />
    </RequirePermission>
  );
}

function Gateway() {
  const { can } = usePermissions();
  const [replacing, setReplacing] = useState(false);
  const query = useQuery({
    queryKey: paymentsKeys.gateway,
    queryFn: () => api<{ gateway: PaymentGateway | null }>('/payments/gateway'),
    // Poll while the notification check waits for its event.
    refetchInterval: (q) => (q.state.data?.gateway?.notificationCheck.status === 'PENDING' ? 2_000 : false),
  });
  const gateway = query.data?.gateway ?? null;

  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <Link href="/payments" className="text-sm text-muted-foreground hover:underline">
          ← Payments
        </Link>
        <h1 className="text-2xl font-semibold">Stripe connection</h1>
        <p className="text-sm text-muted-foreground">
          Customers pay on Stripe&apos;s own payment page; card details never reach this platform. Use a restricted key with Checkout Sessions, Webhook Endpoints and Events access.
        </p>
      </div>
      {query.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {gateway && !replacing ? <ConnectionCard gateway={gateway} onReplace={() => setReplacing(true)} /> : null}
      {query.isSuccess && (!gateway || replacing) ? (
        can('integrations.manage') ? (
          <KeyForm onDone={() => setReplacing(false)} onCancel={gateway ? () => setReplacing(false) : undefined} />
        ) : (
          <p className="text-sm text-muted-foreground">Stripe is not connected. Ask an admin to connect it.</p>
        )
      ) : null}
    </div>
  );
}

function KeyForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const [secretKey, setSecretKey] = useState('');
  const [registerEndpoint, setRegisterEndpoint] = useState(true);
  const [webhookSecret, setWebhookSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<PaymentGateway>('/payments/gateway', {
        method: 'PUT',
        json: { secretKey: secretKey.trim(), registerEndpoint, ...(registerEndpoint ? {} : { webhookSecret: webhookSecret.trim() }) },
      }),
    onSuccess: async (saved) => {
      setError(null);
      setSecretKey('');
      setWebhookSecret('');
      qc.setQueryData(paymentsKeys.gateway, { gateway: saved });
      toast.success(saved.status === 'CONNECTED' ? 'Stripe connected' : 'Saved; some checks need attention');
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Stripe</CardTitle>
        <CardDescription>Stripe Dashboard → Developers → API keys. A test key (rk_test_…) makes no real payments.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="stripe-key">Stripe key</Label>
            <Input id="stripe-key" type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder="rk_live_…" required />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={registerEndpoint} onChange={(e) => setRegisterEndpoint(e.target.checked)} />
            Register the notification address for me
          </label>
          {!registerEndpoint ? (
            <div className="grid gap-2">
              <Label htmlFor="stripe-secret">Signing secret</Label>
              <Input id="stripe-secret" type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="whsec_…" required />
              <p className="text-xs text-muted-foreground">Add the address shown after saving in Stripe → Developers → Webhooks, then paste that endpoint&apos;s signing secret.</p>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending || !secretKey.trim()}>
              {save.isPending ? 'Checking…' : 'Save and check'}
            </Button>
            {onCancel ? (
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function CheckList({ checks }: { checks: GatewayCheck[] }) {
  if (!checks.length) return <p className="text-sm text-muted-foreground">No checks have run yet.</p>;
  return (
    <ul className="grid gap-2">
      {checks.map((c) => (
        <li key={c.check} data-testid={`gateway-check-${c.check}`} className="grid gap-1 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{GATEWAY_CHECK_LABEL[c.check]}</span>
            <Badge variant={RESULT_VARIANT[c.result]}>{RESULT_LABEL[c.result]}</Badge>
          </div>
          <p className="text-sm">{c.detail}</p>
          {c.fix ? <p className="text-sm text-muted-foreground">{c.fix}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function ConnectionCard({ gateway, onReplace }: { gateway: PaymentGateway; onReplace: () => void }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const admin = can('integrations.manage');
  const refresh = (saved: PaymentGateway) => qc.setQueryData(paymentsKeys.gateway, { gateway: saved });
  const recheck = useMutation({ mutationFn: () => api<PaymentGateway>('/payments/gateway/recheck', { method: 'POST' }), onSuccess: refresh, onError: (e) => toast.error(errorMessage(e)) });
  const testNotifications = useMutation({
    mutationFn: () => api<PaymentGateway>('/payments/gateway/notification-check', { method: 'POST' }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const disconnect = useMutation({
    mutationFn: () => api<void>('/payments/gateway', { method: 'DELETE' }),
    onSuccess: () => qc.setQueryData(paymentsKeys.gateway, { gateway: null }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const check = gateway.notificationCheck;

  return (
    <Card data-testid="gateway-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {gateway.accountName ?? 'Stripe account'}
          <Badge variant={gateway.mode === 'TEST' ? 'warning' : 'success'} data-testid="gateway-mode">
            {gateway.mode === 'TEST' ? 'Test mode' : 'Live'}
          </Badge>
          <Badge variant={gateway.status === 'CONNECTED' ? 'success' : 'destructive'}>{gateway.status === 'CONNECTED' ? 'Connected' : 'Needs attention'}</Badge>
        </CardTitle>
        <CardDescription>
          Currency <span data-testid="gateway-currency">{gateway.currency.toUpperCase()}</span>
          {gateway.country ? ` · ${gateway.country}` : ''} · {gateway.keyKind === 'restricted' ? 'restricted key' : 'secret key'}
          {gateway.lastCheckedAt ? ` · checked ${formatDateTime(gateway.lastCheckedAt)}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <CheckList checks={gateway.checks} />
        <div className="grid gap-1 rounded-md border p-3" data-testid="notification-check">
          <span className="text-sm font-medium">Notifications</span>
          {check.status === 'PASSED' ? <p className="text-sm">Notifications working{check.passedAt ? ` (checked ${formatDateTime(check.passedAt)})` : ''}.</p> : null}
          {check.status === 'PENDING' ? <p className="text-sm">Waiting for Stripe&apos;s test notification…</p> : null}
          {check.status === 'FAILED' ? <p className="text-sm text-destructive">{check.fix ?? 'No notification arrived.'}</p> : null}
          {check.status === 'NOT_RUN' ? <p className="text-sm text-muted-foreground">Not tested yet.</p> : null}
          <p className="text-xs text-muted-foreground">
            Notification address: <code>{gateway.webhookUrl}</code>
            {gateway.endpointRegistered ? ' (registered in Stripe by the platform)' : ''}
          </p>
        </div>
        {admin ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => testNotifications.mutate()} disabled={testNotifications.isPending || check.status === 'PENDING'}>
              Test notifications
            </Button>
            <Button variant="outline" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
              Run checks
            </Button>
            <Button variant="outline" onClick={onReplace}>
              Replace keys
            </Button>
            <ConfirmDialog
              title="Disconnect Stripe?"
              description="New payment links stop working until Stripe is connected again. Payment pages already open at Stripe keep working until they expire."
              confirmLabel="Disconnect"
              onConfirm={() => disconnect.mutateAsync()}
              trigger={<Button variant="destructive">Disconnect</Button>}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
