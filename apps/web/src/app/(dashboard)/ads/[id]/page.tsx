'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AD_TEXT_LIMITS, CALL_TO_ACTIONS } from '@wbm/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AdChats } from '@/components/ads/ad-chats';
import { AdManage } from '@/components/ads/ad-manage';
import { AdResultsPanel } from '@/components/ads/ad-results';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { AD_GOAL_LABEL, AD_STATUS_LABEL, AD_STATUS_VARIANT, CALL_TO_ACTION_LABEL, adsKeys, money, type AdCampaign, type AdVersion, type CallToAction } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { flowKeys, type FlowSummary } from '@/lib/flows';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Tag } from '@/lib/types';

const VERSION_VARIANT = { DRAFT: 'outline', IN_REVIEW: 'secondary', ACTIVE: 'success', PAUSED: 'warning', REJECTED: 'destructive', ENDED: 'outline' } as const;
const VERSION_LABEL = { DRAFT: 'Draft', IN_REVIEW: 'In review', ACTIVE: 'Active', PAUSED: 'Paused', REJECTED: 'Rejected', ENDED: 'Ended' } as const;

/** One ad campaign: state, versions with Meta's review, settings after the ad and its chats (feature 007 US2, US3). */
export default function AdCampaignPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <Campaign />
    </RequirePermission>
  );
}

function Campaign() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const campaign = useQuery({
    queryKey: adsKeys.campaign(id),
    queryFn: () => api<AdCampaign>(`/ads/campaigns/${id}`),
    // Meta's review usually ends within minutes; keep the page current meanwhile.
    refetchInterval: (query) => {
      const c = query.state.data;
      return c && (c.status === 'SUBMITTING' || c.status === 'IN_REVIEW' || c.versions.some((v) => v.status === 'IN_REVIEW')) ? 3_000 : 30_000;
    },
  });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: adsKeys.campaign(id) }), queryClient.invalidateQueries({ queryKey: adsKeys.campaigns })]);
  const submit = useMutation({
    mutationFn: () => api<AdCampaign>(`/ads/campaigns/${id}/submit`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Submitted for review');
      await refresh();
    },
    onError: async (e) => {
      toast.error(errorMessage(e));
      await refresh();
    },
  });

  const c = campaign.data;
  if (campaign.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!c) return <p className="text-sm text-muted-foreground">Campaign not found.</p>;
  const draft = (c.status === 'DRAFT' || c.status === 'ERROR') && !c.versions.some((v) => v.metaAdId);
  const edited = c.versions.some((v) => v.edited);

  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <Link href="/ads" className="text-sm text-muted-foreground hover:underline">
          ← Ads
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{c.name}</h1>
          <Badge data-testid="ad-status" variant={AD_STATUS_VARIANT[c.status]}>
            {AD_STATUS_LABEL[c.status]}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {AD_GOAL_LABEL[c.goal]} · {money(c.dailyBudgetMinor, c.currency)} a day · from {formatDateTime(c.startAt)}
          {c.endAt ? ` to ${formatDateTime(c.endAt)}` : ''} · spent {money(c.spendMinor, c.currency)}
        </p>
      </div>

      {c.lastError ? (
        <p role="alert" data-testid="ad-error" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          {c.lastError}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {draft ? (
          <>
            <Can permission="campaigns.manage">
              <Button asChild variant="outline">
                <Link href={`/ads/new?id=${c.id}`}>Edit draft</Link>
              </Button>
            </Can>
            <Can permission="campaigns.launch">
              <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
                {submit.isPending ? 'Submitting…' : 'Submit for review'}
              </Button>
            </Can>
            <Can permission="campaigns.manage">
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" className="text-destructive">
                    Delete draft
                  </Button>
                }
                title="Delete this draft?"
                description="Nothing was sent to Meta yet."
                confirmLabel="Delete"
                confirmVariant="destructive"
                onConfirm={() =>
                  api(`/ads/campaigns/${c.id}`, { method: 'DELETE' })
                    .then(async () => {
                      toast.success('Draft deleted');
                      await queryClient.invalidateQueries({ queryKey: adsKeys.campaigns });
                      router.push('/ads');
                    })
                    .catch((e: unknown) => toast.error(errorMessage(e)))
                }
              />
            </Can>
          </>
        ) : null}
        {!draft && edited ? (
          <Can permission="campaigns.launch">
            <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
              {submit.isPending ? 'Submitting…' : 'Submit edited versions'}
            </Button>
          </Can>
        ) : null}
      </div>

      {!draft ? <AdManage campaign={c} /> : null}

      {!draft ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Results</CardTitle>
          </CardHeader>
          <CardContent>
            <AdResultsPanel campaignId={c.id} versions={c.versions} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Versions</CardTitle>
          <CardDescription>Meta reviews each version; a rejected one can be edited and submitted again.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {c.versions.map((v) => (
            <VersionRow key={v.id} campaign={c} version={v} onSaved={refresh} />
          ))}
        </CardContent>
      </Card>

      <AfterTheAd campaign={c} onSaved={refresh} />

      {c.goal === 'CHATS' && !draft ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Chats from this campaign</CardTitle>
          </CardHeader>
          <CardContent>
            <AdChats campaignId={c.id} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function VersionRow({ campaign, version, onSaved }: { campaign: AdCampaign; version: AdVersion; onSaved: () => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(version.primaryText);
  const [headline, setHeadline] = useState(version.headline);
  const [cta, setCta] = useState<CallToAction>(version.callToAction);
  const save = useMutation({
    mutationFn: () => api<AdCampaign>(`/ads/campaigns/${campaign.id}/versions/${version.id}`, { method: 'PUT', json: { mediaAssetId: version.mediaAssetId, primaryText: text, headline, callToAction: cta } }),
    onSuccess: async () => {
      toast.success('Version saved; submit it again for review');
      setEditing(false);
      await onSaved();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (action: 'pause' | 'resume') => api<AdCampaign>(`/ads/campaigns/${campaign.id}/versions/${version.id}/${action}`, { method: 'POST' }),
    onSuccess: async (_, action) => {
      toast.success(action === 'pause' ? `Version ${version.position} paused` : `Version ${version.position} running again`);
      await onSaved();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const atMeta = Boolean(version.metaAdId) && campaign.status !== 'ENDED';

  return (
    <div className="grid gap-2 rounded-md border p-3" data-testid={`ad-version-row-${version.position}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Version {version.position}</span>
        <Badge variant={VERSION_VARIANT[version.status]}>{VERSION_LABEL[version.status]}</Badge>
        {version.edited ? <Badge variant="outline">Edited, not submitted</Badge> : null}
        <span className="text-xs text-muted-foreground">{version.mediaKind === 'VIDEO' ? 'Video' : 'Image'}</span>
      </div>
      <p className="text-sm font-medium">{version.headline}</p>
      <p className="whitespace-pre-wrap text-sm">{version.primaryText}</p>
      {version.status === 'REJECTED' && version.reviewFeedback ? (
        <p className="text-sm text-destructive" data-testid={`ad-feedback-${version.position}`}>
          Meta&apos;s reason: {version.reviewFeedback}
        </p>
      ) : null}
      {atMeta && (version.status === 'ACTIVE' || version.status === 'IN_REVIEW' || version.status === 'PAUSED') ? (
        <Can permission="campaigns.launch">
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => toggle.mutate(version.status === 'PAUSED' ? 'resume' : 'pause')} disabled={toggle.isPending}>
            {version.status === 'PAUSED' ? `Resume version ${version.position}` : `Pause version ${version.position}`}
          </Button>
        </Can>
      ) : null}
      {version.status === 'REJECTED' && !editing ? (
        <Can permission="campaigns.manage">
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setEditing(true)}>
            Edit version {version.position}
          </Button>
        </Can>
      ) : null}
      {editing ? (
        <div className="grid gap-2">
          <Label htmlFor={`fix-text-${version.id}`}>Main text</Label>
          <textarea id={`fix-text-${version.id}`} className="min-h-20 rounded-md border bg-background p-2 text-sm" maxLength={AD_TEXT_LIMITS.primaryText} value={text} onChange={(e) => setText(e.target.value)} />
          <Label htmlFor={`fix-headline-${version.id}`}>Headline</Label>
          <Input id={`fix-headline-${version.id}`} maxLength={AD_TEXT_LIMITS.headline} value={headline} onChange={(e) => setHeadline(e.target.value)} />
          <Label htmlFor={`fix-cta-${version.id}`}>Button</Label>
          <NativeSelect id={`fix-cta-${version.id}`} value={cta} onChange={(e) => setCta(e.target.value as CallToAction)}>
            {CALL_TO_ACTIONS[campaign.goal].map((x) => (
              <option key={x} value={x}>
                {CALL_TO_ACTION_LABEL[x as CallToAction]}
              </option>
            ))}
          </NativeSelect>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              Save version
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AfterTheAd({ campaign, onSaved }: { campaign: AdCampaign; onSaved: () => Promise<unknown> }) {
  const [flowId, setFlowId] = useState(campaign.flowId ?? '');
  const [tagId, setTagId] = useState(campaign.tagId ?? '');
  const flows = useQuery({ queryKey: flowKeys.list, queryFn: () => api<FlowSummary[]>('/flows'), enabled: campaign.goal === 'CHATS' });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const save = useMutation({
    mutationFn: () => api<AdCampaign>(`/ads/campaigns/${campaign.id}`, { method: 'PATCH', json: { ...(campaign.goal === 'CHATS' ? { flowId: flowId || null } : {}), tagId: tagId || null } }),
    onSuccess: async () => {
      toast.success('Saved');
      await onSaved();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">After the ad</CardTitle>
        <CardDescription>{campaign.goal === 'CHATS' ? 'The flow answers the first message of chats from this campaign, unless another flow is running; the tag is added to the contact.' : 'The tag is added to contacts from this campaign.'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3 sm:items-end">
        {campaign.goal === 'CHATS' ? (
          <div className="grid gap-1.5">
            <Label htmlFor="after-flow">Flow</Label>
            <NativeSelect id="after-flow" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
              <option value="">No flow</option>
              {(flows.data ?? [])
                .filter((f) => f.status === 'PUBLISHED')
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </NativeSelect>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="after-tag">Tag</Label>
          <NativeSelect id="after-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">No tag</option>
            {(tags.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Can permission="campaigns.manage">
          <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
        </Can>
      </CardContent>
    </Card>
  );
}
