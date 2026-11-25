'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AdsCheckBadge, AdsCheckList } from '@/components/ads/ads-checks';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { adsKeys, money, toMajorUnits, toMinorUnits, type AdsChecks, type AdsConnection, type AdsSession } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { Can, usePermissions } from '@/lib/permissions';

/** Ads > Connect (feature 007 US1, T023): token, ad account and page, checks with fixes, save; then the connection card. */
export default function AdsConnectPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <Connect />
    </RequirePermission>
  );
}

function Connect() {
  const { can } = usePermissions();
  const [replacing, setReplacing] = useState(false);
  const connection = useQuery({ queryKey: adsKeys.connection, queryFn: () => api<{ connection: AdsConnection | null }>('/ads/connection') });
  const current = connection.data?.connection ?? null;

  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <Link href="/ads" className="text-sm text-muted-foreground hover:underline">
          ← Ads
        </Link>
        <h1 className="text-2xl font-semibold">Ad account connection</h1>
        <p className="text-sm text-muted-foreground">One Meta ad account and Facebook page run the platform&apos;s ads. Amounts follow the ad account&apos;s currency and time zone.</p>
      </div>
      {connection.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {current && !replacing ? <ConnectionCard connection={current} onReplace={() => setReplacing(true)} /> : null}
      {connection.isSuccess && (!current || replacing) ? (
        can('integrations.manage') ? (
          <ConnectSteps onDone={() => setReplacing(false)} onCancel={current ? () => setReplacing(false) : undefined} />
        ) : (
          <p className="text-sm text-muted-foreground">No ad account is connected. Ask an admin to connect one.</p>
        )
      ) : null}
    </div>
  );
}

function ConnectionCard({ connection, onReplace }: { connection: AdsConnection; onReplace: () => void }) {
  const queryClient = useQueryClient();
  const [checks, setChecks] = useState<AdsChecks>(connection.checks);
  const [cap, setCap] = useState(connection.monthlyCapMinor === null ? '' : String(toMajorUnits(connection.monthlyCapMinor, connection.currency)));
  const refresh = () => queryClient.invalidateQueries({ queryKey: adsKeys.connection });
  const run = useMutation({
    mutationFn: () => api<AdsChecks>('/ads/connection/checks', { method: 'POST', json: {} }),
    onSuccess: async (result) => {
      setChecks(result);
      toast.success(result.ready ? 'All checks passed' : 'Some checks failed');
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const saveCap = useMutation({
    mutationFn: (monthlyCapMinor: number | null) => api<AdsConnection>('/ads/connection/spend-cap', { method: 'PUT', json: { monthlyCapMinor } }),
    onSuccess: async () => {
      toast.success('Spending cap saved');
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  function submitCap(event: FormEvent) {
    event.preventDefault();
    const value = cap.trim();
    if (!value) return saveCap.mutate(null);
    const major = Number(value);
    if (!Number.isFinite(major) || major <= 0) return toast.error('Enter a positive amount, or leave it empty for no cap.');
    saveCap.mutate(toMinorUnits(major, connection.currency));
  }

  return (
    <Card data-testid="ads-connection-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{connection.adAccountName}</CardTitle>
          <Badge variant={connection.status === 'CONNECTED' ? 'success' : 'destructive'}>{connection.status === 'CONNECTED' ? 'Connected' : 'Needs attention'}</Badge>
        </div>
        <CardDescription>
          Ad account {connection.adAccountId} · Page {connection.pageName}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Currency</dt>
            <dd data-testid="ads-currency">{connection.currency}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Time zone</dt>
            <dd data-testid="ads-timezone">{connection.timezone}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Spent this month</dt>
            <dd>{money(connection.monthSpendMinor, connection.currency)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Checked</dt>
            <dd>{formatDateTime(connection.checkedAt)}</dd>
          </div>
        </dl>
        {connection.status === 'ERROR' ? (
          <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
            A check failed, so new ads and changes are on hold. Fix it in Meta and run the checks again.
          </p>
        ) : null}
        <AdsCheckList checks={checks.checks} />
        <Can permission="integrations.manage">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run.mutate()} disabled={run.isPending}>
              {run.isPending ? 'Checking…' : 'Run checks'}
            </Button>
            <Button variant="outline" onClick={onReplace}>
              Replace token
            </Button>
            <ConfirmDialog
              trigger={
                <Button variant="ghost" className="text-destructive">
                  Disconnect
                </Button>
              }
              title="Disconnect the ad account?"
              description="Ads keep running in Meta. Campaigns here become read-only until an ad account is connected again."
              confirmLabel="Disconnect"
              confirmVariant="destructive"
              onConfirm={() =>
                api('/ads/connection', { method: 'DELETE' })
                  .then(() => {
                    toast.success('Ad account disconnected');
                    return refresh();
                  })
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            />
          </div>
          <form onSubmit={submitCap} className="flex flex-wrap items-end gap-2 border-t pt-4">
            <div className="grid gap-1.5">
              <Label htmlFor="ads-cap">Monthly spending cap ({connection.currency})</Label>
              <Input id="ads-cap" inputMode="decimal" placeholder="No cap" value={cap} onChange={(e) => setCap(e.target.value)} className="w-40" />
            </div>
            <Button type="submit" variant="outline" disabled={saveCap.isPending}>
              Save cap
            </Button>
            <p className="w-full text-xs text-muted-foreground">Changes that could pass the cap are refused, and the platform&apos;s ads pause when this month&apos;s spend reaches it.</p>
          </form>
        </Can>
      </CardContent>
    </Card>
  );
}

function ConnectSteps({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [session, setSession] = useState<AdsSession | null>(null);
  const [accountId, setAccountId] = useState('');
  const [pageId, setPageId] = useState('');
  const [checks, setChecks] = useState<AdsChecks | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => api<AdsSession>('/ads/connection/token', { method: 'POST', json: { accessToken: token.trim() } }),
    onSuccess: (s) => {
      setSession(s);
      setAccountId(s.adAccounts.find((a) => a.active)?.id ?? '');
      setPageId(s.pages[0]?.id ?? '');
      setChecks(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const runChecks = useMutation({
    mutationFn: () => api<AdsChecks>('/ads/connection/checks', { method: 'POST', json: { sessionId: session!.id, adAccountId: accountId, pageId } }),
    onSuccess: setChecks,
    onError: (e) => setError(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: () => api<AdsConnection>('/ads/connection', { method: 'POST', json: { sessionId: session!.id, adAccountId: accountId, pageId } }),
    onSuccess: async () => {
      toast.success('Ad account connected');
      await queryClient.invalidateQueries({ queryKey: adsKeys.connection });
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submitToken(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (token.trim().length < 20) {
      setError('Paste the whole access token.');
      return;
    }
    start.mutate();
  }

  return (
    <>
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Access token</CardTitle>
          <CardDescription>
            A system user token from Meta Business Settings with ads_management, ads_read, business_management, pages_show_list and pages_read_engagement; lead ads also need pages_manage_ads,
            pages_manage_metadata and leads_retrieval.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <form onSubmit={submitToken} className="flex flex-wrap items-end gap-2">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="ads-token">Access token</Label>
              <Input id="ads-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono text-sm" />
            </div>
            <Button type="submit" disabled={start.isPending}>
              {start.isPending ? 'Checking…' : 'Check token'}
            </Button>
            {onCancel ? (
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </form>
          {session ? (
            <div data-testid="ads-token" className="grid gap-1 rounded-md border p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">Token</span>
                <AdsCheckBadge check={session.token} />
              </div>
              <p>{session.token.detail}</p>
              {session.token.fix ? <p className="text-muted-foreground">{session.token.fix}</p> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {session && session.token.result !== 'FAILED' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Ad account and page</CardTitle>
            <CardDescription>The ad accounts and pages this token reaches.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Ad account</legend>
              {!session.adAccounts.length ? <p className="text-sm text-muted-foreground">The token reaches no ad account.</p> : null}
              {session.adAccounts.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ads-account"
                    className="size-4"
                    checked={accountId === a.id}
                    onChange={() => {
                      setAccountId(a.id);
                      setChecks(null);
                    }}
                  />
                  {a.name} <span className="text-muted-foreground">· act_{a.id} · {a.currency}</span>
                  {!a.active ? <span className="text-muted-foreground">(not active)</span> : null}
                </label>
              ))}
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Facebook page</legend>
              {!session.pages.length ? <p className="text-sm text-muted-foreground">The token reaches no page.</p> : null}
              {session.pages.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ads-page"
                    className="size-4"
                    checked={pageId === p.id}
                    onChange={() => {
                      setPageId(p.id);
                      setChecks(null);
                    }}
                  />
                  {p.name} <span className="text-muted-foreground">· {p.id}</span>
                </label>
              ))}
            </fieldset>
            <div>
              <Button onClick={() => runChecks.mutate()} disabled={!accountId || !pageId || runChecks.isPending}>
                {runChecks.isPending ? 'Checking…' : checks ? 'Run the checks again' : 'Run checks'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {checks ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. Checks</CardTitle>
            <CardDescription>{checks.ready ? 'Ready to save. Warnings only limit the parts they name.' : 'Fix the failed checks in Meta, then run the checks again.'}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <AdsCheckList checks={checks.checks} />
            <div>
              <Button onClick={() => save.mutate()} disabled={!checks.ready || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save connection'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
