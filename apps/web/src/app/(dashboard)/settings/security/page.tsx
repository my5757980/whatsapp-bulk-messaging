'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { useMe } from '@/lib/session';

// Feature 010 (US6, contracts/login-2fa.md §6): require two-factor sign-in for everyone, see each member's
// state, and reset a member who lost their phone.

interface SecuritySettings {
  require2fa: boolean;
  members: Array<{ userId: string; name: string | null; email: string; role: string; twoFactorEnabled: boolean }>;
}
const securityKey = ['settings', 'security'] as const;

export default function SecurityPage() {
  return (
    <RequirePermission permission="users.manage">
      <Security />
    </RequirePermission>
  );
}

function Security() {
  const queryClient = useQueryClient();
  const me = useMe();
  const settings = useQuery({ queryKey: securityKey, queryFn: () => api<SecuritySettings>('/settings/security') });
  const save = useMutation({
    mutationFn: (require2fa: boolean) => api<SecuritySettings>('/settings/security', { method: 'PUT', json: { require2fa } }),
    onSuccess: (s) => {
      queryClient.setQueryData(securityKey, s);
      toast.success(s.require2fa ? 'Two-factor sign-in is now required' : 'Two-factor sign-in is no longer required');
    },
    onError: toastError,
  });
  const reset = useMutation({
    mutationFn: (userId: string) => api(`/users/${userId}/2fa/reset`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Two-factor sign-in reset; the member was signed out');
      await queryClient.invalidateQueries({ queryKey: securityKey });
    },
    onError: toastError,
  });

  if (settings.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!settings.data) return <p className="text-sm text-destructive">{errorMessage(settings.error)}</p>;
  const s = settings.data;

  return (
    <div className="grid max-w-3xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Two-factor sign-in</CardTitle>
          <CardDescription>
            When required, members without it set it up at their next sign-in. Members already signed in stay signed in and see a reminder. API keys are not
            affected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.require2fa} disabled={save.isPending} onChange={(e) => save.mutate(e.target.checked)} />
            Require two-factor sign-in for every member
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>Resetting removes a member&apos;s authenticator and recovery codes and signs them out everywhere.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Two-factor</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.members.map((m) => (
                <TableRow key={m.userId} data-testid="security-member">
                  <TableCell>
                    <div className="font-medium">{m.name ?? m.email}</div>
                    <div className="text-xs text-muted-foreground">{m.email}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.role.toLowerCase()}</TableCell>
                  <TableCell>
                    <Badge variant={m.twoFactorEnabled ? 'success' : 'secondary'}>{m.twoFactorEnabled ? 'On' : 'Off'}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {m.twoFactorEnabled && m.userId !== me.data?.id ? (
                      <Button variant="ghost" size="sm" onClick={() => reset.mutate(m.userId)} disabled={reset.isPending}>
                        Reset
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
