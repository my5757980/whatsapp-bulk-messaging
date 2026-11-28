'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CodeField, RecoveryCodesList, SetupSecret, type TwoFactorSetup } from '@/components/auth/two-factor-parts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { myTwoFactorKey, type MyTwoFactor } from '@/lib/two-factor';

// Feature 010 (US6, contracts/login-2fa.md §5): the signed-in member's own two-factor sign-in.

const codeError = (e: unknown) => (e instanceof ApiError && e.code === 'INVALID_CODE' ? 'That code is not right. Try the newest code from your app.' : errorMessage(e));

export default function TwoFactorPage() {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: myTwoFactorKey, queryFn: () => api<MyTwoFactor>('/me/2fa') });
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [action, setAction] = useState<'codes' | 'off' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: myTwoFactorKey });

  const start = useMutation({
    mutationFn: () => api<TwoFactorSetup>('/me/2fa/setup', { method: 'POST' }),
    onSuccess: (s) => {
      setError(null);
      setCode('');
      setSetup(s);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const confirm = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/me/2fa/confirm', { method: 'POST', json: { code } }),
    onSuccess: async (r) => {
      setError(null);
      setSetup(null);
      setCode('');
      setCodes(r.recoveryCodes);
      toast.success('Two-factor sign-in is on');
      await refresh();
    },
    onError: (e) => setError(codeError(e)),
  });
  const withCode = useMutation({
    mutationFn: async (kind: 'codes' | 'off') => {
      if (kind === 'codes') return (await api<{ recoveryCodes: string[] }>('/me/2fa/recovery-codes', { method: 'POST', json: { code } })).recoveryCodes;
      await api('/me/2fa/disable', { method: 'POST', json: { code } });
      return null;
    },
    onSuccess: async (newCodes) => {
      setError(null);
      setCode('');
      setAction(null);
      if (newCodes) setCodes(newCodes);
      else toast.success('Two-factor sign-in is off');
      await refresh();
    },
    onError: (e) => setError(codeError(e)),
  });

  if (state.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!state.data) return <p className="text-sm text-destructive">{errorMessage(state.error)}</p>;
  const s = state.data;

  return (
    <div className="grid max-w-xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Two-factor sign-in</h1>
        <p className="text-sm text-muted-foreground">After your password, sign-in asks for a code from an authenticator app on your phone.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Status
            <Badge variant={s.enabled ? 'success' : 'secondary'} data-testid="two-factor-status">
              {s.enabled ? 'On' : 'Off'}
            </Badge>
          </CardTitle>
          <CardDescription>
            {s.enabled
              ? `On since ${formatDateTime(s.enabledAt)}. ${s.recoveryCodesLeft} recovery code${s.recoveryCodesLeft === 1 ? '' : 's'} left.`
              : s.required
                ? 'Your company requires two-factor sign-in. Set it up now.'
                : 'Turn it on to protect your account even if someone learns your password.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {codes ? (
            <RecoveryCodesList codes={codes} onDone={() => setCodes(null)} />
          ) : setup ? (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                confirm.mutate();
              }}
            >
              <SetupSecret setup={setup} />
              <CodeField id="confirm-code" value={code} onChange={setCode} />
              <div className="flex gap-2">
                <Button type="submit" disabled={code.length !== 6 || confirm.isPending}>
                  Confirm
                </Button>
                <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : !s.enabled ? (
            <div>
              <Button onClick={() => start.mutate()} disabled={start.isPending}>
                Turn on two-factor sign-in
              </Button>
            </div>
          ) : action ? (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                withCode.mutate(action);
              }}
            >
              <CodeField id="action-code" value={code} onChange={setCode} label={action === 'off' ? 'Code from your app, to turn it off' : 'Code from your app, to make new codes'} />
              <div className="flex gap-2">
                <Button type="submit" disabled={code.length !== 6 || withCode.isPending}>
                  {action === 'off' ? 'Turn off' : 'Make new codes'}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAction(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setAction('codes')}>
                Make new recovery codes
              </Button>
              {s.required ? (
                <span className="self-center text-xs text-muted-foreground">Your company requires it, so it cannot be turned off.</span>
              ) : (
                <Button variant="outline" onClick={() => setAction('off')}>
                  Turn off
                </Button>
              )}
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
