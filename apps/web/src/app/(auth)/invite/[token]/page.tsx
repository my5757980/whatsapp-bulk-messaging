'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { queryKeys } from '@/lib/query';

/** Invitation accept page (T177): choose a name and password, then you are signed in. */
export default function AcceptInvitationPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<{ email: string; role: string }>(`/auth/invitations/${token}`),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const accept = useMutation({
    mutationFn: () => api(`/auth/invitations/${token}/accept`, { method: 'POST', json: { name: name.trim(), password } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      router.replace('/campaigns');
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Enter your name.');
    if (password.length < 12) return setError('Use at least 12 characters for your password.');
    if (password !== confirm) return setError('The passwords do not match.');
    accept.mutate();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Join the team</CardTitle>
          <CardDescription>
            {invitation.data ? `${invitation.data.email} · ${invitation.data.role.toLowerCase()}` : 'WhatsApp Bulk Messaging'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invitation.isLoading ? <p className="text-sm text-muted-foreground">Checking your invitation…</p> : null}
          {invitation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              This invitation link is invalid or has expired. Ask an admin to send a new one.
            </p>
          ) : null}
          {invitation.data ? (
            <form onSubmit={submit} className="grid gap-4" noValidate>
              <div className="grid gap-1.5">
                <Label htmlFor="invite-name">Your name</Label>
                <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="invite-password">Password (at least 12 characters)</Label>
                <Input id="invite-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="invite-confirm">Repeat password</Label>
                <Input id="invite-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" disabled={accept.isPending}>
                {accept.isPending ? 'Setting up…' : 'Create my account'}
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
