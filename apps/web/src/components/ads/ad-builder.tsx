'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AD_TEXT_LIMITS, AD_TEXT_RECOMMENDED, CALL_TO_ACTIONS, type AdGoal, type AdSpecialCategoryName } from '@wbm/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { OptionSearch } from '@/components/ads/option-search';
import { mediaLibraryKey, type MediaItem } from '@/components/inbox/media-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import {
  AD_GOAL_LABEL,
  CALL_TO_ACTION_LABEL,
  SPECIAL_CATEGORY_LABEL,
  adsKeys,
  money,
  toMajorUnits,
  toMinorUnits,
  type AdAudience,
  type AdCampaign,
  type AdCampaignInput,
  type AdsConnection,
  type AdEstimate,
  type AdLeadForm,
  type AdVersionInput,
  type CallToAction,
  type Placements,
  type Targeting,
} from '@/lib/ads';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { flowKeys, type FlowSummary } from '@/lib/flows';
import { usePermissions } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Tag, WhatsAppNumber } from '@/lib/types';

const GOALS: AdGoal[] = ['CHATS', 'LEADS', 'WEBSITE'];
const CATEGORIES: AdSpecialCategoryName[] = ['NONE', 'CREDIT', 'EMPLOYMENT', 'HOUSING', 'SOCIAL_ISSUES'];

function localInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const emptyVersion = (goal: AdGoal): AdVersionInput => ({ mediaAssetId: '', primaryText: '', headline: '', callToAction: CALL_TO_ACTIONS[goal][0] as CallToAction });

/** The guided ad builder (feature 007 US2, T031): goal, chat number and message, audience, placements, budget, versions, review. */
export function AdBuilder({ campaign }: { campaign?: AdCampaign }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const connection = useQuery({ queryKey: adsKeys.connection, queryFn: () => api<{ connection: AdsConnection | null }>('/ads/connection') });
  const currency = campaign?.currency ?? connection.data?.connection?.currency ?? 'USD';

  const [name, setName] = useState(campaign?.name ?? '');
  const [goal, setGoal] = useState<AdGoal>(campaign?.goal ?? 'CHATS');
  const [numberId, setNumberId] = useState(campaign?.numberId ?? '');
  const [message, setMessage] = useState(campaign?.prefilledMessage ?? '');
  const [leadFormId, setLeadFormId] = useState(campaign?.leadFormId ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(campaign?.websiteUrl ?? '');
  const [targeting, setTargeting] = useState<Targeting>(campaign?.targeting ?? { locations: [], ageMin: 18, ageMax: 65, genders: 'ALL', interests: [] });
  const [placements, setPlacements] = useState<Placements>(campaign?.placements ?? { auto: true });
  const [category, setCategory] = useState<AdSpecialCategoryName>(campaign?.specialCategory ?? 'NONE');
  const [budget, setBudget] = useState(campaign ? String(toMajorUnits(campaign.dailyBudgetMinor, campaign.currency)) : '');
  const [startAt, setStartAt] = useState(localInput(campaign?.startAt ?? new Date().toISOString()));
  const [endAt, setEndAt] = useState(localInput(campaign?.endAt));
  const [flowId, setFlowId] = useState(campaign?.flowId ?? '');
  const [tagId, setTagId] = useState(campaign?.tagId ?? '');
  const [versions, setVersions] = useState<AdVersionInput[]>(
    campaign?.versions.map((v) => ({ mediaAssetId: v.mediaAssetId, primaryText: v.primaryText, headline: v.headline, callToAction: v.callToAction })) ?? [emptyVersion('CHATS')],
  );
  const [estimate, setEstimate] = useState<AdEstimate | null>(null);
  const [problems, setProblems] = useState<Array<{ field?: string; issue?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const special = category !== 'NONE';

  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers'), enabled: goal === 'CHATS' });
  const forms = useQuery({ queryKey: adsKeys.leadForms, queryFn: () => api<AdLeadForm[]>('/ads/lead-forms'), enabled: goal === 'LEADS' });
  const media = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60') });
  const flows = useQuery({ queryKey: flowKeys.list, queryFn: () => api<FlowSummary[]>('/flows'), enabled: goal === 'CHATS' });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const audiences = useQuery({ queryKey: adsKeys.audiences, queryFn: () => api<AdAudience[]>('/ads/audiences') });
  const readyAudiences = (audiences.data ?? []).filter((a) => a.status === 'READY');
  const toggleAudience = (key: 'includeAudienceIds' | 'excludeAudienceIds', id: string, on: boolean) =>
    setTargeting((t) => {
      const other = key === 'includeAudienceIds' ? 'excludeAudienceIds' : 'includeAudienceIds';
      const list = new Set(t[key] ?? []);
      if (on) list.add(id);
      else list.delete(id);
      return { ...t, [key]: [...list], [other]: (t[other] ?? []).filter((x) => !on || x !== id) };
    });
  const visual = (media.data?.items ?? []).filter((m) => m.kind === 'image' || m.kind === 'video');

  useEffect(() => {
    // Buttons follow the goal.
    setVersions((list) => list.map((v) => (CALL_TO_ACTIONS[goal].includes(v.callToAction) ? v : { ...v, callToAction: CALL_TO_ACTIONS[goal][0] as CallToAction })));
    if (goal !== 'CHATS') setPlacements((p) => ({ ...p, whatsappStatus: false }));
  }, [goal]);

  function body(): AdCampaignInput {
    return {
      name: name.trim(),
      goal,
      numberId: goal === 'CHATS' ? numberId || null : null,
      prefilledMessage: goal === 'CHATS' ? message.trim() || null : null,
      leadFormId: goal === 'LEADS' ? leadFormId || null : null,
      websiteUrl: goal === 'WEBSITE' ? websiteUrl.trim() || null : null,
      targeting: special ? { ...targeting, ageMin: 18, ageMax: 65, genders: 'ALL', interests: [] } : targeting,
      placements,
      specialCategory: category,
      dailyBudgetMinor: toMinorUnits(Number(budget || 0), currency),
      startAt: new Date(startAt || Date.now()).toISOString(),
      endAt: endAt ? new Date(endAt).toISOString() : null,
      flowId: goal === 'CHATS' ? flowId || null : null,
      tagId: tagId || null,
      versions,
    };
  }

  const runEstimate = useMutation({
    mutationFn: () => api<AdEstimate>('/ads/targeting/estimate', { method: 'POST', json: { goal, targeting: body().targeting, placements } }),
    onSuccess: setEstimate,
    onError: (e) => setError(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const input = body();
      const saved = campaign
        ? await api<AdCampaign>(`/ads/campaigns/${campaign.id}`, { method: 'PATCH', json: { ...input, goal: undefined } })
        : await api<AdCampaign>('/ads/campaigns', { method: 'POST', json: input });
      if (!submit) return saved;
      try {
        return await api<AdCampaign>(`/ads/campaigns/${saved.id}/submit`, { method: 'POST' });
      } catch (e) {
        // Saved as a draft; the problems are shown on the campaign page.
        toast.error(errorMessage(e));
        return saved;
      }
    },
    onSuccess: async (saved, submit) => {
      await queryClient.invalidateQueries({ queryKey: adsKeys.campaigns });
      toast.success(submit ? 'Submitted for review' : 'Draft saved');
      router.push(`/ads/${saved.id}`);
    },
    onError: (e) => {
      setError(errorMessage(e));
      setProblems(e instanceof ApiError ? (e.details ?? []) : []);
    },
  });

  const setVersion = (i: number, patch: Partial<AdVersionInput>) => setVersions((list) => list.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const togglePlacement = (platform: 'facebook' | 'instagram', position: string, on: boolean) =>
    setPlacements((p) => {
      const list = new Set<string>(p[platform] ?? []);
      if (on) list.add(position);
      else list.delete(position);
      return { ...p, [platform]: [...list] };
    });

  return (
    <div className="grid max-w-3xl gap-6">
      {error ? (
        <div role="alert" className="grid gap-1 rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          <p>{error}</p>
          {problems.length ? (
            <ul className="list-disc pl-5">
              {problems.map((p, i) => (
                <li key={i}>
                  {p.field}: {p.issue}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Goal</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ad-name">Campaign name</Label>
            <Input id="ad-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <fieldset className="grid gap-2" disabled={Boolean(campaign)}>
            <legend className="text-sm font-medium">What should the ad do?</legend>
            {GOALS.map((g) => (
              <label key={g} className="flex items-center gap-2 text-sm">
                <input type="radio" name="ad-goal" className="size-4" checked={goal === g} onChange={() => setGoal(g)} />
                {AD_GOAL_LABEL[g]}
              </label>
            ))}
          </fieldset>
          {goal === 'CHATS' ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="ad-number">WhatsApp number</Label>
                <NativeSelect id="ad-number" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
                  <option value="">Choose a number</option>
                  {(numbers.data ?? []).map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label} ({n.displayPhoneNumber})
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ad-message">Pre-filled message</Label>
                <Input id="ad-message" value={message} maxLength={AD_TEXT_LIMITS.prefilledMessage} onChange={(e) => setMessage(e.target.value)} placeholder="Hi, I saw your ad" />
                <p className="text-xs text-muted-foreground">
                  What the customer&apos;s message box shows when they tap the ad ({message.length}/{AD_TEXT_LIMITS.prefilledMessage}).
                </p>
              </div>
            </>
          ) : null}
          {goal === 'LEADS' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ad-form">Lead form</Label>
              <NativeSelect id="ad-form" value={leadFormId} onChange={(e) => setLeadFormId(e.target.value)}>
                <option value="">Choose a lead form</option>
                {(forms.data ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          {goal === 'WEBSITE' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ad-url">Web page (https)</Label>
              <Input id="ad-url" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://" />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Audience</CardTitle>
          <CardDescription>Meta&apos;s own lists of places and interests.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ad-category">Is the ad about credit, employment, housing or social issues?</Label>
            <NativeSelect id="ad-category" value={category} onChange={(e) => setCategory(e.target.value as AdSpecialCategoryName)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {SPECIAL_CATEGORY_LABEL[c]}
                </option>
              ))}
            </NativeSelect>
            {special ? <p className="text-xs text-muted-foreground">Meta keeps these ads broad: age, gender and interests cannot be narrowed.</p> : null}
          </div>
          <OptionSearch id="ad-locations" label="Places" kind="locations" value={targeting.locations} max={50} onChange={(locations) => setTargeting((t) => ({ ...t, locations }))} />
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ad-age-min">Age from</Label>
              <Input id="ad-age-min" type="number" min={18} max={65} disabled={special} value={targeting.ageMin ?? 18} onChange={(e) => setTargeting((t) => ({ ...t, ageMin: Number(e.target.value) }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ad-age-max">Age to</Label>
              <Input id="ad-age-max" type="number" min={18} max={65} disabled={special} value={targeting.ageMax ?? 65} onChange={(e) => setTargeting((t) => ({ ...t, ageMax: Number(e.target.value) }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ad-genders">Gender</Label>
              <NativeSelect id="ad-genders" disabled={special} value={targeting.genders ?? 'ALL'} onChange={(e) => setTargeting((t) => ({ ...t, genders: e.target.value as Targeting['genders'] }))}>
                <option value="ALL">All</option>
                <option value="WOMEN">Women</option>
                <option value="MEN">Men</option>
              </NativeSelect>
            </div>
          </div>
          <OptionSearch
            id="ad-interests"
            label="Interests (optional)"
            kind="interests"
            value={targeting.interests ?? []}
            max={25}
            disabled={special}
            onChange={(interests) => setTargeting((t) => ({ ...t, interests }))}
          />
          {readyAudiences.length ? (
            <fieldset className="grid gap-1" data-testid="ad-audiences">
              <legend className="text-sm font-medium">Saved audiences (optional)</legend>
              {readyAudiences.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="min-w-40">{a.name}</span>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" className="size-4" checked={(targeting.includeAudienceIds ?? []).includes(a.id)} onChange={(e) => toggleAudience('includeAudienceIds', a.id, e.target.checked)} aria-label={`Show to ${a.name}`} />
                    Show to
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" className="size-4" checked={(targeting.excludeAudienceIds ?? []).includes(a.id)} onChange={(e) => toggleAudience('excludeAudienceIds', a.id, e.target.checked)} aria-label={`Leave out ${a.name}`} />
                    Leave out
                  </label>
                </div>
              ))}
            </fieldset>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={() => runEstimate.mutate()} disabled={!targeting.locations.length || runEstimate.isPending}>
              {runEstimate.isPending ? 'Estimating…' : 'Estimate audience'}
            </Button>
            {estimate ? (
              <p className="text-sm" data-testid="ad-estimate">
                {estimate.audienceLower !== null && estimate.audienceUpper !== null
                  ? `About ${estimate.audienceLower.toLocaleString()}–${estimate.audienceUpper.toLocaleString()} people.`
                  : 'Meta cannot estimate this audience.'}{' '}
                Minimum daily budget: {money(estimate.minDailyBudgetMinor, estimate.currency)}.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. Placements</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4" checked={placements.auto} onChange={(e) => setPlacements(e.target.checked ? { auto: true } : { auto: false, facebook: ['feed'], instagram: ['stream'] })} />
            Automatic placements (recommended)
          </label>
          {!placements.auto ? (
            <div className="grid gap-1 pl-6">
              {(
                [
                  ['facebook', 'feed', 'Facebook feed'],
                  ['facebook', 'story', 'Facebook stories'],
                  ['instagram', 'stream', 'Instagram feed'],
                  ['instagram', 'story', 'Instagram stories'],
                ] as const
              ).map(([platform, position, label]) => (
                <label key={label} className="flex items-center gap-2">
                  <input type="checkbox" className="size-4" checked={(placements[platform] as string[] | undefined)?.includes(position) ?? false} onChange={(e) => togglePlacement(platform, position, e.target.checked)} />
                  {label}
                </label>
              ))}
              {goal === 'CHATS' ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-4" checked={placements.whatsappStatus ?? false} onChange={(e) => setPlacements((p) => ({ ...p, whatsappStatus: e.target.checked }))} />
                  WhatsApp Status (Instagram stories are added, as Meta asks)
                </label>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. Budget and dates</CardTitle>
          <CardDescription>Amounts are in {currency}, the ad account&apos;s currency.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ad-budget">Daily budget ({currency})</Label>
            <Input id="ad-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ad-start">Start</Label>
            <Input id="ad-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ad-end">End (optional)</Label>
            <Input id="ad-end" type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">5. Versions</CardTitle>
          <CardDescription>Up to five versions; Meta shows each to part of the audience. Images or videos come from the media library.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {versions.map((v, i) => (
            <fieldset key={i} className="grid gap-2 rounded-md border p-3" data-testid={`ad-version-${i + 1}`}>
              <legend className="px-1 text-sm font-medium">Version {i + 1}</legend>
              <div className="grid gap-1.5">
                <Label htmlFor={`ad-media-${i}`}>Image or video</Label>
                <NativeSelect id={`ad-media-${i}`} value={v.mediaAssetId} onChange={(e) => setVersion(i, { mediaAssetId: e.target.value })}>
                  <option value="">Choose from the media library</option>
                  {visual.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName ?? m.id} ({m.kind})
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`ad-text-${i}`}>Main text</Label>
                <textarea
                  id={`ad-text-${i}`}
                  className="min-h-20 rounded-md border bg-background p-2 text-sm"
                  maxLength={AD_TEXT_LIMITS.primaryText}
                  value={v.primaryText}
                  onChange={(e) => setVersion(i, { primaryText: e.target.value })}
                />
                <p className={`text-xs ${v.primaryText.length > AD_TEXT_RECOMMENDED.primaryText ? 'text-amber-600' : 'text-muted-foreground'}`}>
                  {v.primaryText.length}/{AD_TEXT_RECOMMENDED.primaryText} recommended
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`ad-headline-${i}`}>Headline</Label>
                <Input id={`ad-headline-${i}`} maxLength={AD_TEXT_LIMITS.headline} value={v.headline} onChange={(e) => setVersion(i, { headline: e.target.value })} />
                <p className={`text-xs ${v.headline.length > AD_TEXT_RECOMMENDED.headline ? 'text-amber-600' : 'text-muted-foreground'}`}>
                  {v.headline.length}/{AD_TEXT_RECOMMENDED.headline} recommended
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`ad-cta-${i}`}>Button</Label>
                <NativeSelect id={`ad-cta-${i}`} value={v.callToAction} onChange={(e) => setVersion(i, { callToAction: e.target.value as CallToAction })}>
                  {CALL_TO_ACTIONS[goal].map((c) => (
                    <option key={c} value={c}>
                      {CALL_TO_ACTION_LABEL[c as CallToAction]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {versions.length > 1 ? (
                <Button type="button" variant="ghost" className="justify-self-start text-destructive" onClick={() => setVersions((list) => list.filter((_, j) => j !== i))}>
                  Remove version {i + 1}
                </Button>
              ) : null}
            </fieldset>
          ))}
          {versions.length < 5 ? (
            <Button type="button" variant="outline" className="justify-self-start" onClick={() => setVersions((list) => [...list, emptyVersion(goal)])}>
              Add a version
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">6. After the ad</CardTitle>
          <CardDescription>Optional: a tag for contacts who come from the ad{goal === 'CHATS' ? ', and a flow that answers their first message' : ''}.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {goal === 'CHATS' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ad-flow">Flow</Label>
              <NativeSelect id="ad-flow" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
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
            <Label htmlFor="ad-tag">Tag</Label>
            <NativeSelect id="ad-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">No tag</option>
              {(tags.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending || !name.trim()}>
          Save draft
        </Button>
        {can('campaigns.launch') ? (
          <Button onClick={() => save.mutate(true)} disabled={save.isPending || !name.trim()}>
            {save.isPending ? 'Saving…' : 'Submit for review'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
