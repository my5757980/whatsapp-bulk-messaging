'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { WizardCheckList } from '@/components/integrations/wizard-checks';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { type WizardCheck, type WizardChecks, type WizardSession } from '@/lib/integrations';

interface Picked {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
}

interface TestResult {
  sent: boolean;
  delivered: boolean;
  error: string | null;
}

const RESULT_VARIANT = { PASSED: 'success', WARNING: 'warning', FAILED: 'destructive' } as const;

/** Numbers > Connect with checks (feature 006 US8, T084): token, pick, checks with fixes, test message, save. */
export default function ConnectNumberWizardPage() {
  return (
    <RequirePermission permission="numbers.manage">
      <Wizard />
    </RequirePermission>
  );
}

function Wizard() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [session, setSession] = useState<WizardSession | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [checks, setChecks] = useState<WizardChecks | null>(null);
  const [pin, setPin] = useState('');
  const [to, setTo] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [arrived, setArrived] = useState(false);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = picked ? { wabaId: picked.wabaId, phoneNumberId: picked.phoneNumberId } : null;

  const start = useMutation({
    mutationFn: () => api<WizardSession>('/number-wizard/sessions', { method: 'POST', json: { accessToken: token.trim() } }),
    onSuccess: (s) => {
      setSession(s);
      setPicked(null);
      setChecks(null);
      setTest(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const runChecks = useMutation({
    mutationFn: () => api<WizardChecks>(`/number-wizard/sessions/${session!.id}/checks`, { method: 'POST', json: ref }),
    onSuccess: setChecks,
    onError: (e) => setError(errorMessage(e)),
  });
  const fix = useMutation({
    mutationFn: (check: WizardCheck) =>
      api<WizardChecks>(`/number-wizard/sessions/${session!.id}/fixes`, {
        method: 'POST',
        json: { ...ref, fix: check.fixAction, ...(check.fixAction === 'REGISTER_NUMBER' ? { pin } : {}) },
      }),
    onSuccess: (result) => {
      setChecks(result);
      toast.success('Done; the checks ran again');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const sendTest = useMutation({
    mutationFn: () => api<TestResult>(`/number-wizard/sessions/${session!.id}/test-message`, { method: 'POST', json: { ...ref, to: to.trim() } }),
    onSuccess: setTest,
    onError: (e) => setError(errorMessage(e)),
  });
  const connect = useMutation({
    mutationFn: (withoutTest: boolean) => api<{ id: string }>(`/number-wizard/sessions/${session!.id}/connect`, { method: 'POST', json: { ...ref, label: label.trim(), withoutTest } }),
    onSuccess: () => {
      toast.success('Number connected');
      router.push('/settings/numbers');
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

  const tokenOk = session && session.token.result !== 'FAILED';

  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <Link href="/settings/numbers" className="text-sm text-muted-foreground hover:underline">
          ← WhatsApp numbers
        </Link>
        <h1 className="text-2xl font-semibold">Connect a number with checks</h1>
        <p className="text-sm text-muted-foreground">Paste the access token once. We check it, list the numbers it reaches and check the one you pick, with a fix for anything missing.</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Access token</CardTitle>
          <CardDescription>A system user token from Meta Business Settings with the permissions whatsapp_business_management and whatsapp_business_messaging.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <form onSubmit={submitToken} className="flex flex-wrap items-end gap-2">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="wiz-token">Access token</Label>
              <Input id="wiz-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono text-sm" />
            </div>
            <Button type="submit" disabled={start.isPending}>
              {start.isPending ? 'Checking…' : 'Check token'}
            </Button>
          </form>
          {session ? (
            <div data-testid="wizard-token" className="grid gap-1 rounded-md border p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">Token</span>
                <Badge variant={RESULT_VARIANT[session.token.result]}>{session.token.result === 'PASSED' ? 'Passed' : session.token.result === 'WARNING' ? 'Warning' : 'Failed'}</Badge>
              </div>
              <p>{session.token.detail}</p>
              {session.token.fix ? <p className="text-muted-foreground">{session.token.fix}</p> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {tokenOk ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Pick the number</CardTitle>
            <CardDescription>The WhatsApp accounts and numbers this token can reach.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {!session.accounts.length ? <p className="text-sm text-muted-foreground">The token reaches no WhatsApp account.</p> : null}
            {session.accounts.map((a) => (
              <fieldset key={a.wabaId} className="grid gap-2">
                <legend className="text-sm font-medium">{a.name}</legend>
                {a.numbers.map((n) => (
                  <label key={n.phoneNumberId} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="wizard-number"
                      className="size-4"
                      disabled={n.alreadyConnected}
                      checked={picked?.phoneNumberId === n.phoneNumberId}
                      onChange={() => {
                        setPicked({ wabaId: a.wabaId, phoneNumberId: n.phoneNumberId, displayPhoneNumber: n.displayPhoneNumber, verifiedName: n.verifiedName });
                        setChecks(null);
                        setTest(null);
                        if (!label) setLabel(n.verifiedName ?? n.displayPhoneNumber);
                      }}
                    />
                    {n.displayPhoneNumber}
                    {n.verifiedName ? <span className="text-muted-foreground">· {n.verifiedName}</span> : null}
                    {n.alreadyConnected ? <span className="text-muted-foreground">(already connected)</span> : null}
                  </label>
                ))}
              </fieldset>
            ))}
            <div>
              <Button onClick={() => runChecks.mutate()} disabled={!picked || runChecks.isPending}>
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
            <CardDescription data-testid="wizard-ready">{checks.ready ? 'Ready: nothing failed.' : 'Fix the failed checks below, then send the test message.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <WizardCheckList
              checks={checks.checks}
              renderFix={(c) =>
                c.fixAction === 'REGISTER_NUMBER' ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="wiz-pin">Two-step PIN</Label>
                      <Input id="wiz-pin" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} className="w-32 font-mono" />
                    </div>
                    <Button size="sm" variant="outline" disabled={pin.length !== 6 || fix.isPending} onClick={() => fix.mutate(c)}>
                      Register the number
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Button size="sm" variant="outline" disabled={fix.isPending} onClick={() => fix.mutate(c)}>
                      Subscribe the app
                    </Button>
                  </div>
                )
              }
            />
          </CardContent>
        </Card>
      ) : null}

      {checks ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">4. Test message</CardTitle>
            <CardDescription>We send an approved template to your own WhatsApp and wait up to a minute for its delivered status, which proves replies and statuses reach us.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="wiz-to">Your WhatsApp number</Label>
                <Input id="wiz-to" value={to} placeholder="+971 50 123 4567" onChange={(e) => setTo(e.target.value)} className="w-56" />
              </div>
              <Button variant="outline" disabled={!to.trim() || sendTest.isPending} onClick={() => sendTest.mutate()}>
                {sendTest.isPending ? 'Waiting for the delivered status…' : 'Send test message'}
              </Button>
            </div>
            {test ? (
              <p data-testid="wizard-test-result" className={test.delivered ? 'text-sm' : 'text-sm text-destructive'}>
                {test.delivered ? 'Delivered: the status arrived.' : test.sent ? `Sent, but ${test.error ?? 'no delivered status arrived'}.` : `Not sent: ${test.error ?? 'unknown error'}.`}
              </p>
            ) : null}
            {test?.sent ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={arrived} onChange={(e) => setArrived(e.target.checked)} />I got the message on my phone
              </label>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {checks ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">5. Save</CardTitle>
            <CardDescription>The token is stored encrypted and never shown again.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-label">Name in the dashboard</Label>
              <Input id="wiz-label" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} className="w-72" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!label.trim() || !test?.sent || !arrived || connect.isPending} onClick={() => connect.mutate(false)}>
                Save number
              </Button>
              <Button variant="ghost" disabled={!label.trim() || connect.isPending} onClick={() => connect.mutate(true)}>
                Save without the test
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
