'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AudienceRuleBuilder, isCompleteRule } from '@/components/campaigns/audience-rule-builder';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { adsKeys, type AdAudience } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, AudienceRule, Campaign, Paged, Tag } from '@/lib/types';

const STATUS_LABEL = { SYNCING: 'Updating', READY: 'Ready', TOO_SMALL: 'Too small (under 100)', ERROR: 'Error' } as const;
const STATUS_VARIANT = { SYNCING: 'secondary', READY: 'success', TOO_SMALL: 'warning', ERROR: 'destructive' } as const;
const GROUPS = [
  ['CLICKED', 'Clicked a link'],
  ['REPLIED', 'Replied'],
  ['READ', 'Read'],
  ['DELIVERED', 'Received'],
  ['NOT_CLICKED', 'Received, no click'],
  ['NOT_REPLIED', 'Received, no reply'],
] as const;
const RATIOS = [1, 2, 3, 5, 10];

/** Ads > Audiences (feature 007 US6, FR-031 – FR-034): saved audiences from contacts, kept up to date, and lookalikes. */
export default function AdAudiencesPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <Audiences />
    </RequirePermission>
  );
}

function Audiences() {
  const audiences = useQuery({
    queryKey: adsKeys.audiences,
    queryFn: () => api<AdAudience[]>('/ads/audiences'),
    refetchInterval: (query) => ((query.state.data ?? []).some((a) => a.status === 'SYNCING') ? 3_000 : 30_000),
  });
  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <Link href="/ads" className="text-sm text-muted-foreground hover:underline">
          ← Ads
        </Link>
        <h1 className="text-2xl font-semibold">Audiences</h1>
        <p className="text-sm text-muted-foreground">
          Show ads to the company&apos;s own contacts, or to people like them. Only phone numbers are sent, as hashes; opted-out and blocked contacts are never sent. Audiences update once a day.
        </p>
      </div>
      <Can permission="campaigns.manage">
        <NewAudience />
      </Can>
      {audiences.data?.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Audience</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">People</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {audiences.data.map((a) => (
              <AudienceRow key={a.id} audience={a} />
            ))}
          </TableBody>
        </Table>
      ) : audiences.isSuccess ? (
        <p className="text-sm text-muted-foreground">No audiences yet.</p>
      ) : null}
    </div>
  );
}

function AudienceRow({ audience: a }: { audience: AdAudience }) {
  const queryClient = useQueryClient();
  const [lookalike, setLookalike] = useState(false);
  const [country, setCountry] = useState('AE');
  const [ratio, setRatio] = useState(1);
  const refresh = () => queryClient.invalidateQueries({ queryKey: adsKeys.audiences });
  const sync = useMutation({
    mutationFn: () => api(`/ads/audiences/${a.id}/sync`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Updating at Meta');
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const look = useMutation({
    mutationFn: () => api<AdAudience>(`/ads/audiences/${a.id}/lookalikes`, { method: 'POST', json: { country: country.trim().toUpperCase(), ratio: ratio / 100 } }),
    onSuccess: async () => {
      toast.success('Lookalike made');
      setLookalike(false);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <TableRow data-testid="audience-row">
      <TableCell>
        <span className="font-medium">{a.name}</span>
        <span className="block text-xs text-muted-foreground">
          {a.kind === 'LOOKALIKE' ? `Lookalike · ${a.lookalikeCountry} · ${Math.round((a.lookalikeRatio ?? 0) * 100)}%` : 'Saved audience'}
        </span>
        {a.lastError ? <span className="block text-xs text-destructive">{a.lastError}</span> : null}
        {lookalike ? (
          <span className="mt-2 flex flex-wrap items-end gap-2">
            <span className="grid gap-1">
              <Label htmlFor={`look-country-${a.id}`}>Country</Label>
              <Input id={`look-country-${a.id}`} value={country} maxLength={2} onChange={(e) => setCountry(e.target.value)} className="w-16" />
            </span>
            <span className="grid gap-1">
              <Label htmlFor={`look-ratio-${a.id}`}>Size</Label>
              <NativeSelect id={`look-ratio-${a.id}`} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} className="w-28">
                {RATIOS.map((r) => (
                  <option key={r} value={r}>
                    {r}% (closest)
                  </option>
                ))}
              </NativeSelect>
            </span>
            <Button size="sm" onClick={() => look.mutate()} disabled={look.isPending}>
              Make lookalike
            </Button>
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[a.status]} data-testid="audience-status">
          {STATUS_LABEL[a.status]}
        </Badge>
      </TableCell>
      <TableCell className="text-right" data-testid="audience-size">
        {a.kind === 'LOOKALIKE' ? '—' : formatNumber(a.memberCount)}
      </TableCell>
      <TableCell>{formatDateTime(a.syncedAt)}</TableCell>
      <TableCell>
        <Can permission="campaigns.manage">
          <span className="flex flex-wrap justify-end gap-1">
            {a.kind === 'CUSTOM' ? (
              <Button size="sm" variant="ghost" onClick={() => sync.mutate()} disabled={sync.isPending || a.status === 'SYNCING'}>
                Update now
              </Button>
            ) : null}
            {a.kind === 'CUSTOM' && a.status === 'READY' && !lookalike ? (
              <Button size="sm" variant="ghost" onClick={() => setLookalike(true)}>
                Lookalike…
              </Button>
            ) : null}
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="ghost" className="text-destructive">
                  Delete
                </Button>
              }
              title={`Delete ${a.name}?`}
              description="It is deleted at Meta too, with its lookalikes. Campaigns that are running with it must end first."
              confirmLabel="Delete"
              confirmVariant="destructive"
              onConfirm={() =>
                api(`/ads/audiences/${a.id}`, { method: 'DELETE' })
                  .then(async () => {
                    toast.success('Audience deleted');
                    await refresh();
                  })
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            />
          </span>
        </Can>
      </TableCell>
    </TableRow>
  );
}

function NewAudience() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<'tag' | 'filter' | 'campaign_group'>('tag');
  const [tagId, setTagId] = useState('');
  const [rules, setRules] = useState<AudienceRule[]>([{ tag: '' }]);
  const [campaignId, setCampaignId] = useState('');
  const [group, setGroup] = useState<(typeof GROUPS)[number][0]>('CLICKED');
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes'), enabled: type === 'filter' });
  const campaigns = useQuery({ queryKey: ['campaigns', 'for-audiences'], queryFn: () => api<Paged<Campaign>>('/campaigns?page=1&pageSize=100'), enabled: type === 'campaign_group' });
  const create = useMutation({
    mutationFn: () => {
      const source =
        type === 'tag' ? { type, tagId } : type === 'filter' ? { type, filter: { all: rules.filter(isCompleteRule) } } : { type, campaignId, group };
      return api<AdAudience>('/ads/audiences', { method: 'POST', json: { name: name.trim(), source } });
    },
    onSuccess: async () => {
      toast.success('Audience made; it is being sent to Meta');
      setName('');
      await queryClient.invalidateQueries({ queryKey: adsKeys.audiences });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return toast.error('Name the audience.');
    if (type === 'tag' && !tagId) return toast.error('Choose a tag.');
    if (type === 'filter' && !rules.some(isCompleteRule)) return toast.error('Add at least one complete rule.');
    if (type === 'campaign_group' && !campaignId) return toast.error('Choose a campaign.');
    create.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New audience</CardTitle>
        <CardDescription>Meta needs at least 100 matched people before an audience can be used.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="audience-name">Name</Label>
            <Input id="audience-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audience-source">Contacts from</Label>
            <NativeSelect id="audience-source" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="tag">A tag</option>
              <option value="filter">A contact filter</option>
              <option value="campaign_group">A campaign group</option>
            </NativeSelect>
          </div>
          {type === 'tag' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="audience-tag">Tag</Label>
              <NativeSelect id="audience-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
                <option value="">Choose a tag</option>
                {(tags.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.contactCount})
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          {type === 'filter' ? <AudienceRuleBuilder rules={rules} onChange={setRules} tags={tags.data ?? []} attributes={attributes.data ?? []} /> : null}
          {type === 'campaign_group' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="audience-campaign">Campaign</Label>
                <NativeSelect id="audience-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                  <option value="">Choose a campaign</option>
                  {(campaigns.data?.items ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="audience-group">Who</Label>
                <NativeSelect id="audience-group" value={group} onChange={(e) => setGroup(e.target.value as typeof group)}>
                  {GROUPS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          ) : null}
          <Button type="submit" className="justify-self-start" disabled={create.isPending}>
            {create.isPending ? 'Making…' : 'Make audience'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
