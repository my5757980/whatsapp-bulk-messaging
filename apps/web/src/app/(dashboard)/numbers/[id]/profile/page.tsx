'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BUSINESS_PROFILE_LIMITS, BUSINESS_VERTICALS, checkBusinessProfile, checkProfilePicture, type BusinessProfileInput, type FieldIssue } from '@wbm/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type ChangeEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { Can, usePermissions } from '@/lib/permissions';

// Feature 010 (US7, FR-031 – FR-033): the WhatsApp Business profile, the display name status, quality and
// messaging limit, and the blue tick checklist.

interface BusinessProfile {
  numberId: string;
  about: string | null;
  address: string | null;
  description: string | null;
  email: string | null;
  websites: string[];
  vertical: string | null;
  profilePictureUrl: string | null;
  verifiedName: string | null;
  nameStatus: string | null;
  newNameStatus: string | null;
  qualityRating: string | null;
  messagingLimit: string | null;
  readAt: string;
  changedAt: string | null;
}

interface ObaChecklist {
  steps: Array<{ id: string; title: string; body: string; links: Array<{ label: string; url: string }>; done: boolean; at: string | null; optional?: boolean }>;
  appliedAt: string | null;
  result: 'PENDING' | 'APPROVED' | 'DECLINED' | null;
  note: string | null;
  checkedAt: string;
}

const NAME_STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  APPROVED: { label: 'Approved', variant: 'success' },
  PENDING_REVIEW: { label: 'In review', variant: 'warning' },
  DECLINED: { label: 'Declined', variant: 'destructive' },
  EXPIRED: { label: 'Expired', variant: 'destructive' },
  NONE: { label: 'Not set', variant: 'secondary' },
};
const QUALITY_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = { GREEN: 'success', YELLOW: 'warning', RED: 'destructive' };
const TEXTAREA = 'min-h-[72px] w-full rounded-md border bg-background px-3 py-2 text-sm';

export default function NumberProfilePage() {
  return (
    <RequirePermission permission="numbers.view">
      <NumberProfile />
    </RequirePermission>
  );
}

function NumberProfile() {
  const { id } = useParams<{ id: string }>();
  const profile = useQuery({ queryKey: ['numbers', id, 'business-profile'], queryFn: () => api<BusinessProfile>(`/numbers/${id}/business-profile`), retry: false });
  return (
    <div className="grid max-w-4xl gap-6">
      <Link href="/settings/numbers" className="text-sm text-muted-foreground hover:underline">
        ← WhatsApp numbers
      </Link>
      <h1 className="text-2xl font-semibold">Business profile</h1>
      {profile.isLoading ? <p className="text-sm text-muted-foreground">Loading from Meta…</p> : null}
      {profile.error ? <p className="text-sm text-destructive">{errorMessage(profile.error)}</p> : null}
      {profile.data ? (
        <>
          <NameStatus profile={profile.data} />
          <ProfileForm numberId={id} profile={profile.data} />
          <Picture numberId={id} profile={profile.data} />
        </>
      ) : null}
      <Checklist />
    </div>
  );
}

function NameStatus({ profile }: { profile: BusinessProfile }) {
  const status = NAME_STATUS[profile.nameStatus ?? 'NONE'] ?? { label: profile.nameStatus ?? 'Unknown', variant: 'secondary' as const };
  const declined = profile.nameStatus === 'DECLINED' || profile.nameStatus === 'EXPIRED';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {profile.verifiedName ?? 'Display name'}
          <Badge variant={status.variant} data-testid="name-status">
            {status.label}
          </Badge>
          <Badge variant={QUALITY_VARIANT[profile.qualityRating ?? ''] ?? 'secondary'}>Quality: {(profile.qualityRating ?? 'unknown').toLowerCase()}</Badge>
          {profile.messagingLimit ? <Badge variant="outline">Limit: {profile.messagingLimit.replace('TIER_', '')} a day</Badge> : null}
        </CardTitle>
        <CardDescription>Read from Meta {formatDateTime(profile.readAt)}. The messaging limit is shared by every number of the business portfolio.</CardDescription>
      </CardHeader>
      {declined || profile.newNameStatus ? (
        <CardContent className="grid gap-2 text-sm">
          {profile.newNameStatus ? <p>Name change: {(NAME_STATUS[profile.newNameStatus]?.label ?? profile.newNameStatus).toLowerCase()}</p> : null}
          {declined ? (
            <div className="rounded-md border border-destructive/40 p-3" data-testid="name-declined-steps">
              <p className="font-medium">The display name is not approved.</p>
              <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
                <li>Open WhatsApp Manager → Account tools → Phone numbers.</li>
                <li>Edit the display name so it matches the business&apos;s brand on its website and signs.</li>
                <li>Submit it for review; messages keep working while Meta reviews it.</li>
              </ol>
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function ProfileForm({ numberId, profile }: { numberId: string; profile: BusinessProfile }) {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const editable = can('numbers.manage');
  const [form, setForm] = useState({ about: '', address: '', description: '', email: '', website1: '', website2: '', vertical: '' });
  const [loaded, setLoaded] = useState(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded) {
      setForm({
        about: profile.about ?? '',
        address: profile.address ?? '',
        description: profile.description ?? '',
        email: profile.email ?? '',
        website1: profile.websites[0] ?? '',
        website2: profile.websites[1] ?? '',
        vertical: profile.vertical ?? '',
      });
      setLoaded(true);
    }
  }, [profile, loaded]);
  const input = (): BusinessProfileInput => ({
    about: form.about.trim(),
    address: form.address.trim(),
    description: form.description.trim(),
    email: form.email.trim(),
    websites: [form.website1.trim(), form.website2.trim()].filter(Boolean),
    vertical: form.vertical,
  });
  const save = useMutation({
    mutationFn: () => api<BusinessProfile>(`/numbers/${numberId}/business-profile`, { method: 'PUT', json: input() }),
    onSuccess: (saved) => {
      setError(null);
      queryClient.setQueryData(['numbers', numberId, 'business-profile'], saved);
      toast.success('Profile saved on WhatsApp');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    const found = checkBusinessProfile(input());
    setIssues(found);
    if (!found.length) save.mutate();
  };
  const issueFor = (field: string) => issues.filter((i) => i.field === field || i.field.startsWith(`${field}.`)).map((i) => i.issue).join('; ');
  const L = BUSINESS_PROFILE_LIMITS;
  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
        <CardDescription>What customers see in the number&apos;s WhatsApp profile. Only changed fields are sent to Meta.</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={!editable || !loaded} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="profile-about">About ({form.about.length}/{L.about.max})</Label>
            <Input id="profile-about" value={form.about} maxLength={L.about.max} onChange={set('about')} />
            {issueFor('about') ? <p className="text-xs text-destructive">{issueFor('about')}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="profile-description">Description ({form.description.length}/{L.description.max})</Label>
            <textarea id="profile-description" className={TEXTAREA} value={form.description} maxLength={L.description.max} onChange={set('description')} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="profile-address">Address</Label>
              <Input id="profile-address" value={form.address} maxLength={L.address.max} onChange={set('address')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="profile-email">Email</Label>
              <Input id="profile-email" type="email" value={form.email} maxLength={L.email.max} onChange={set('email')} />
              {issueFor('email') ? <p className="text-xs text-destructive">{issueFor('email')}</p> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="profile-website1">Website</Label>
              <Input id="profile-website1" value={form.website1} maxLength={L.websites.max} onChange={set('website1')} placeholder="https://" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="profile-website2">Second website</Label>
              <Input id="profile-website2" value={form.website2} maxLength={L.websites.max} onChange={set('website2')} placeholder="https://" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="profile-vertical">Category</Label>
              <NativeSelect id="profile-vertical" value={form.vertical} onChange={set('vertical')}>
                <option value="">No category</option>
                {BUSINESS_VERTICALS.map((v) => (
                  <option key={v} value={v}>
                    {v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ')}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          {issueFor('websites') ? <p className="text-xs text-destructive">{issueFor('websites')}</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {editable ? (
            <div>
              <Button type="button" onClick={submit} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save profile'}
              </Button>
            </div>
          ) : null}
        </fieldset>
      </CardContent>
    </Card>
  );
}

/** Reads a picture's pixel size in the browser, so the square rule is checked before uploading. */
function pictureSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function Picture({ numberId, profile }: { numberId: string; profile: BusinessProfile }) {
  const queryClient = useQueryClient();
  const [issues, setIssues] = useState<string[]>([]);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return api<BusinessProfile>(`/numbers/${numberId}/business-profile/picture`, { method: 'POST', body });
    },
    onSuccess: (saved) => {
      setIssues([]);
      queryClient.setQueryData(['numbers', numberId, 'business-profile'], saved);
      toast.success('Picture saved on WhatsApp');
    },
    onError: (e) => setIssues([errorMessage(e)]),
  });
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const size = await pictureSize(file);
    const found = checkProfilePicture({ type: file.type, bytes: file.size, ...size });
    setIssues(found.map((i) => i.issue));
    if (!found.length) upload.mutate(file);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile picture</CardTitle>
        <CardDescription>A square JPEG or PNG of at least 192×192 pixels, up to 5 MB. The file is sent to Meta and not kept here.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        {profile.profilePictureUrl ? <img src={profile.profilePictureUrl} alt="Current profile picture" className="h-20 w-20 rounded-full border object-cover" /> : null}
        <Can permission="numbers.manage">
          <div className="grid gap-1.5">
            <Label htmlFor="profile-picture">New picture</Label>
            <Input id="profile-picture" type="file" accept="image/jpeg,image/png" onChange={(e) => void choose(e)} disabled={upload.isPending} />
          </div>
        </Can>
        {issues.length ? (
          <p role="alert" className="w-full text-sm text-destructive" data-testid="picture-issues">
            {issues.join('; ')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Checklist() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const editable = can('numbers.manage');
  const checklist = useQuery({ queryKey: ['oba-checklist'], queryFn: () => api<ObaChecklist>('/oba-checklist') });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<ObaChecklist>('/oba-checklist', { method: 'PUT', json: body }),
    onSuccess: (saved) => queryClient.setQueryData(['oba-checklist'], saved),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const c = checklist.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Blue tick checklist</CardTitle>
        <CardDescription>What Meta looks for before it grants an official business account. Meta decides; tick the steps as you finish them.{c ? ` Steps checked against Meta's pages on ${c.checkedAt}.` : ''}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {(c?.steps ?? []).map((s) => (
          <label key={s.id} className="flex items-start gap-3 rounded-md border p-3 text-sm" data-testid={`oba-step-${s.id}`}>
            <input type="checkbox" className="mt-1" checked={s.done} disabled={!editable || save.isPending} onChange={(e) => save.mutate({ steps: { [s.id]: e.target.checked } })} />
            <span className="grid gap-1">
              <span className="font-medium">
                {s.title}
                {s.optional ? <span className="text-muted-foreground"> (helps, not required)</span> : null}
              </span>
              <span className="text-muted-foreground">{s.body}</span>
              {s.links.length ? (
                <span className="flex flex-wrap gap-3">
                  {s.links.map((l) => (
                    <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="text-xs underline">
                      {l.label}
                    </a>
                  ))}
                </span>
              ) : null}
              {s.done && s.at ? <span className="text-xs text-muted-foreground">Done {formatDateTime(s.at)}</span> : null}
            </span>
          </label>
        ))}
        {c ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="oba-applied">Applied on</Label>
              <Input id="oba-applied" type="date" defaultValue={c.appliedAt ?? ''} disabled={!editable} onBlur={(e) => save.mutate({ appliedAt: e.target.value || null })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="oba-result">Result</Label>
              <NativeSelect id="oba-result" value={c.result ?? ''} disabled={!editable} onChange={(e) => save.mutate({ result: e.target.value || null })}>
                <option value="">Not applied</option>
                <option value="PENDING">Waiting for Meta</option>
                <option value="APPROVED">Approved</option>
                <option value="DECLINED">Declined (apply again after 30 days)</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="oba-note">Note</Label>
              <Input id="oba-note" defaultValue={c.note ?? ''} maxLength={500} disabled={!editable} onBlur={(e) => save.mutate({ note: e.target.value })} />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
