'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { CodeField, RecoveryCodesList, SetupSecret, type TwoFactorSetup } from '@/components/auth/two-factor-parts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { ApiError, api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query';

const schema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
type LoginValues = z.infer<typeof schema>;

/** Sign-in page (T069), with the feature 010 second step (contracts/login-2fa.md). */
export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'PASSWORD' | 'CODE' | 'SETUP'>('PASSWORD');
  const form = useForm<LoginValues>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } });

  async function signedIn() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    router.replace('/campaigns');
  }

  async function onSubmit(values: LoginValues) {
    setError(null);
    try {
      const answer = await api<{ next?: 'CODE' | 'SETUP' }>('/auth/login', { method: 'POST', json: values });
      if (answer.next) {
        setStep(answer.next);
        return;
      }
      await signedIn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setError('Too many sign-in attempts. Try again in a few minutes.');
      else if (e instanceof ApiError && e.status === 401) setError('Invalid email or password.');
      else setError('Could not reach the server. Please try again.');
    }
  }

  if (step !== 'PASSWORD') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted p-4">
        <Card className="w-full max-w-sm">
          {step === 'CODE' ? <CodeStep onSignedIn={signedIn} onExpired={() => setStep('PASSWORD')} /> : <SetupStep onSignedIn={signedIn} onExpired={() => setStep('PASSWORD')} />}
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>WhatsApp Bulk Messaging</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4" noValidate>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <Input id="field-email" type="email" autoComplete="email" {...field} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <Input id="field-password" type="password" autoComplete="current-password" {...field} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}

/** Why a second-step request failed, in words; an expired pending sign-in goes back to the password. */
function stepError(e: unknown, onExpired: () => void): string {
  if (e instanceof ApiError && e.code === 'PENDING_SIGN_IN_EXPIRED') {
    onExpired();
    return 'Your sign-in expired. Enter your password again.';
  }
  if (e instanceof ApiError && e.code === 'SECOND_STEP_LOCKED') return 'Too many wrong codes. Try again in 15 minutes.';
  if (e instanceof ApiError && e.code === 'INVALID_CODE') return 'That code is not right. Try the newest code from your app.';
  return 'Could not reach the server. Please try again.';
}

function CodeStep({ onSignedIn, onExpired }: { onSignedIn: () => Promise<void>; onExpired: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api<{ recoveryCodesLeft?: number }>('/auth/login/code', { method: 'POST', json: recovery === null ? { code } : { recoveryCode: recovery.trim() } });
      if (user.recoveryCodesLeft === 0) toast.error('You used your last recovery code. Make new ones on the Two-factor sign-in page.');
      await onSignedIn();
    } catch (e) {
      setError(stepError(e, onExpired));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <CardHeader>
        <CardTitle>Two-factor sign-in</CardTitle>
        <CardDescription>{recovery === null ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes.'}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {recovery === null ? (
            <CodeField id="login-code" value={code} onChange={setCode} />
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="login-recovery">Recovery code</Label>
              <Input id="login-recovery" value={recovery} maxLength={11} onChange={(e) => setRecovery(e.target.value)} placeholder="ABCDE-FGHJK" autoComplete="off" />
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={busy || (recovery === null ? code.length !== 6 : recovery.trim().length < 10)}>
            {busy ? 'Checking…' : 'Sign in'}
          </Button>
          <button type="button" className="text-left text-sm text-muted-foreground hover:underline" onClick={() => setRecovery(recovery === null ? '' : null)}>
            {recovery === null ? 'Use a recovery code instead' : 'Use a code from my app'}
          </button>
        </form>
      </CardContent>
    </>
  );
}

function SetupStep({ onSignedIn, onExpired }: { onSignedIn: () => Promise<void>; onExpired: () => void }) {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api<TwoFactorSetup>('/auth/login/setup', { method: 'POST' }));
    } catch (e) {
      setError(stepError(e, onExpired));
    } finally {
      setBusy(false);
    }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCodes((await api<{ recoveryCodes: string[] }>('/auth/login/setup/confirm', { method: 'POST', json: { code } })).recoveryCodes);
    } catch (e) {
      setError(stepError(e, onExpired));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <CardHeader>
        <CardTitle>Set up two-factor sign-in</CardTitle>
        <CardDescription>Your company asks every member to use a code from an authenticator app when signing in.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {codes ? (
          <RecoveryCodesList codes={codes} onDone={() => void onSignedIn()} doneLabel="I saved my codes, continue" />
        ) : setup ? (
          <form onSubmit={confirm} className="grid gap-4" noValidate>
            <SetupSecret setup={setup} />
            <CodeField id="setup-code" value={code} onChange={setCode} />
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Checking…' : 'Confirm'}
            </Button>
          </form>
        ) : (
          <Button type="button" onClick={() => void start()} disabled={busy}>
            {busy ? 'Starting…' : 'Start setup'}
          </Button>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </>
  );
}
