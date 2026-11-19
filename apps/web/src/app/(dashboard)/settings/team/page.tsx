'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime, titleCase } from '@/lib/format';
import { useMe } from '@/lib/session';

type Role = 'ADMIN' | 'MANAGER' | 'AGENT';
interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'INVITED' | 'ACTIVE' | 'DEACTIVATED';
  lastLoginAt: string | null;
}
interface InviteResult {
  inviteUrl: string;
  expiresAt: string;
  emailed: boolean;
}

const STATUS_VARIANT = { ACTIVE: 'success', INVITED: 'secondary', DEACTIVATED: 'outline' } as const;
const ROLE_HINT: Record<Role, string> = {
  ADMIN: 'Everything, including team, numbers, API keys and the audit log',
  MANAGER: 'Contacts, templates and campaigns; sees full phone numbers',
  AGENT: 'Read-only campaigns and contacts with masked phone numbers',
};

/** Settings > Team (T178): invite, change roles, deactivate and reactivate. */
export default function TeamPage() {
  return (
    <RequirePermission permission="users.manage">
      <Team />
    </RequirePermission>
  );
}

function Team() {
  const queryClient = useQueryClient();
  const me = useMe();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<TeamMember[]>('/users') });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });
  const update = (id: string, body: Partial<Pick<TeamMember, 'role' | 'status'>>) =>
    api<TeamMember>(`/users/${id}`, { method: 'PATCH', json: body })
      .then(() => invalidate())
      .catch(toastError);

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Team</h2>
          <p className="text-sm text-muted-foreground">People join by invitation only. Role changes apply immediately.</p>
        </div>
        <InviteDialog onInvited={invalidate} />
      </div>
      <Card>
        <CardContent className="p-0">
          {users.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : users.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(users.error)}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(users.data ?? []).map((u) => (
                  <TableRow key={u.id} data-testid="team-row">
                    <TableCell>
                      <div className="font-medium">
                        {u.name}
                        {u.id === me.data?.id ? <span className="text-xs text-muted-foreground"> (you)</span> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </TableCell>
                    <TableCell>
                      <NativeSelect
                        aria-label={`Role of ${u.email}`}
                        className="w-32"
                        value={u.role}
                        disabled={u.status === 'DEACTIVATED'}
                        onChange={(e) => void update(u.id, { role: e.target.value as Role })}
                      >
                        <option value="ADMIN">Admin</option>
                        <option value="MANAGER">Manager</option>
                        <option value="AGENT">Agent</option>
                      </NativeSelect>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[u.status]}>{titleCase(u.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(u.lastLoginAt)}</TableCell>
                    <TableCell className="text-right">
                      {u.status === 'ACTIVE' ? (
                        <ConfirmDialog
                          trigger={
                            <Button variant="ghost" size="sm" className="text-destructive">
                              Deactivate
                            </Button>
                          }
                          title={`Deactivate ${u.name}?`}
                          description="They are signed out everywhere and cannot sign in until reactivated. Their past actions stay in the audit log."
                          confirmLabel="Deactivate"
                          confirmVariant="destructive"
                          onConfirm={() => update(u.id, { status: 'DEACTIVATED' })}
                        />
                      ) : null}
                      {u.status === 'DEACTIVATED' ? (
                        <Button variant="ghost" size="sm" onClick={() => void update(u.id, { status: 'ACTIVE' })}>
                          Reactivate
                        </Button>
                      ) : null}
                      {u.status === 'INVITED' ? <InviteDialog onInvited={invalidate} resend={{ email: u.email, role: u.role }} /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Roles</CardTitle>
          <CardDescription>
            {(Object.keys(ROLE_HINT) as Role[]).map((r) => (
              <span key={r} className="block">
                <span className="font-medium">{titleCase(r)}:</span> {ROLE_HINT[r]}
              </span>
            ))}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function InviteDialog({ onInvited, resend }: { onInvited: () => void; resend?: { email: string; role: Role } }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>(resend?.role ?? 'AGENT');
  const [result, setResult] = useState<InviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: (body: { email: string; role: Role }) => api<InviteResult>('/users/invitations', { method: 'POST', json: body }),
    onSuccess: (r) => {
      setResult(r);
      onInvited();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    invite.mutate({ email, role });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setResult(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>{resend ? <Button variant="ghost" size="sm">New invite link</Button> : <Button>Invite member</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{resend ? `New invite link for ${resend.email}` : 'Invite a team member'}</DialogTitle>
          <DialogDescription>The link works once and expires after 7 days.</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-3">
            <Label htmlFor="invite-url">Invitation link</Label>
            <div className="flex gap-2">
              <Input id="invite-url" readOnly value={result.inviteUrl} onFocus={(e) => e.currentTarget.select()} />
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(result.inviteUrl)
                    .then(() => toast.success('Link copied'))
                    .catch(() => toast.error('Copy failed; select the link and copy it'))
                }
              >
                Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {result.emailed ? 'We also e-mailed the link.' : 'E-mail is not set up, so send this link to them yourself.'} Expires {formatDateTime(result.expiresAt)}.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="invite-email">E-mail</Label>
              <Input id="invite-email" name="email" type="email" required defaultValue={resend?.email ?? ''} readOnly={Boolean(resend)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <NativeSelect id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="AGENT">Agent</option>
                <option value="MANAGER">Manager</option>
                <option value="ADMIN">Admin</option>
              </NativeSelect>
              <p className="text-xs text-muted-foreground">{ROLE_HINT[role]}</p>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending ? 'Creating…' : 'Create invitation'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
