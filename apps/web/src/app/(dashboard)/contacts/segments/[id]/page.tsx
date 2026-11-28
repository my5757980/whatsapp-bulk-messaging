'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LEAD_SOURCE_KINDS, LEAD_SOURCE_LABELS, SegmentRulesSchema } from '@wbm/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { BROKEN_ISSUE_TEXT, contacts010Keys, type Segment, type SegmentPreview, type SegmentRule, type SegmentRules } from '@/lib/contacts-010';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, Tag } from '@/lib/types';

// Feature 010 (US1, FR-001 – FR-003, FR-006): the segment editor with live counts and a sample.

type Group = SegmentRules['groups'][number];
const DEFAULT_RULE: SegmentRule = { kind: 'consent', statuses: ['OPTED_IN'] };
const KINDS: Array<{ value: SegmentRule['kind']; label: string }> = [
  { value: 'tag', label: 'Tag' },
  { value: 'attr', label: 'Attribute' },
  { value: 'consent', label: 'Consent' },
  { value: 'lead_source', label: 'Lead source' },
  { value: 'added', label: 'Date added' },
  { value: 'last_inbound', label: 'Last message from them' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'behaviour', label: 'Campaign behaviour' },
];
const START: Record<SegmentRule['kind'], SegmentRule> = {
  tag: { kind: 'tag', tag: '', has: true },
  attr: { kind: 'attr', attr: '', op: 'eq', value: '' },
  consent: { kind: 'consent', statuses: ['OPTED_IN'] },
  lead_source: { kind: 'lead_source', sources: ['ORGANIC'] },
  added: { kind: 'added', days: 30 },
  last_inbound: { kind: 'last_inbound', within: true, days: 30 },
  blocked: { kind: 'blocked', blocked: false },
  behaviour: { kind: 'behaviour', event: 'read', did: true, days: 30 },
};

export default function SegmentEditorPage() {
  return (
    <RequirePermission permission="contacts.view">
      <SegmentEditor />
    </RequirePermission>
  );
}

function SegmentEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const router = useRouter();
  const queryClient = useQueryClient();
  const segment = useQuery({ queryKey: contacts010Keys.segment(id), queryFn: () => api<Segment>(`/segments/${id}`), enabled: !isNew });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const campaigns = useQuery({ queryKey: ['campaigns', 'for-segments'], queryFn: () => api<{ items: Array<{ id: string; name: string }> }>('/campaigns?pageSize=100') });
  const [name, setName] = useState('');
  const [groups, setGroups] = useState<Group[]>([{ match: 'all', rules: [DEFAULT_RULE] }]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (segment.data) {
      setName(segment.data.name);
      setGroups(segment.data.rules.groups);
    }
  }, [segment.data]);

  const rules: SegmentRules = { groups };
  const valid = SegmentRulesSchema.safeParse(rules).success;
  const [debounced, setDebounced] = useState(rules);
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ groups }), 400);
    return () => clearTimeout(t);
  }, [groups]);
  const preview = useQuery({
    queryKey: ['segment-preview', JSON.stringify(debounced)],
    queryFn: () => api<SegmentPreview>('/segments/preview', { method: 'POST', json: { rules: debounced } }),
    enabled: SegmentRulesSchema.safeParse(debounced).success,
  });

  const save = useMutation({
    mutationFn: () => (isNew ? api<Segment>('/segments', { method: 'POST', json: { name, rules } }) : api<Segment>(`/segments/${id}`, { method: 'PUT', json: { name, rules } })),
    onSuccess: (saved) => {
      setError(null);
      toast.success('Segment saved');
      void queryClient.invalidateQueries({ queryKey: contacts010Keys.segments });
      if (isNew) router.push(`/contacts/segments/${saved.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/segments/${id}`, { method: 'DELETE' }),
    onSuccess: () => router.push('/contacts/segments'),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const setRule = (g: number, r: number, rule: SegmentRule) => setGroups(groups.map((grp, i) => (i === g ? { ...grp, rules: grp.rules.map((x, j) => (j === r ? rule : x)) } : grp)));
  const removeRule = (g: number, r: number) =>
    setGroups(groups.map((grp, i) => (i === g ? { ...grp, rules: grp.rules.filter((_, j) => j !== r) } : grp)).filter((grp) => grp.rules.length > 0));
  const broken = isNew ? [] : (segment.data?.broken ?? []);

  if (!isNew && segment.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="grid gap-6">
      <div>
        <Link href="/contacts/segments" className="text-sm text-muted-foreground hover:underline">
          ← Segments
        </Link>
        <h1 className="text-2xl font-semibold">{isNew ? 'New segment' : segment.data?.name}</h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-4">
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor="segment-name">Name</Label>
            <Input id="segment-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Dubai customers" />
          </div>
          {groups.map((group, g) => (
            <Card key={g} data-testid={`segment-group-${g + 1}`}>
              <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="text-base">{g === 0 ? 'Contacts who match' : 'and also'}</CardTitle>
                <NativeSelect aria-label={`Group ${g + 1} match`} className="w-32" value={group.match} onChange={(e) => setGroups(groups.map((x, i) => (i === g ? { ...x, match: e.target.value as 'all' | 'any' } : x)))}>
                  <option value="all">all of</option>
                  <option value="any">any of</option>
                </NativeSelect>
              </CardHeader>
              <CardContent className="grid gap-3">
                {group.rules.map((rule, r) => (
                  <RuleRow
                    key={r}
                    label={`Rule ${g + 1}.${r + 1}`}
                    rule={rule}
                    broken={broken.find((b) => b.group === g && b.rule === r)?.issue}
                    tags={tags.data ?? []}
                    attributes={attributes.data ?? []}
                    campaigns={campaigns.data?.items ?? []}
                    onChange={(next) => setRule(g, r, next)}
                    onRemove={() => removeRule(g, r)}
                  />
                ))}
                <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setGroups(groups.map((x, i) => (i === g ? { ...x, rules: [...x.rules, DEFAULT_RULE] } : x)))}>
                  Add rule
                </Button>
              </CardContent>
            </Card>
          ))}
          {groups.length < 5 ? (
            <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => setGroups([...groups, { match: 'any', rules: [DEFAULT_RULE] }])}>
              Add a group
            </Button>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Can permission="campaigns.manage">
            <div className="flex gap-2">
              <Button onClick={() => save.mutate()} disabled={!name.trim() || !valid || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save segment'}
              </Button>
              {!isNew ? (
                <Button variant="outline" onClick={() => window.confirm('Delete this segment?') && remove.mutate()}>
                  Delete
                </Button>
              ) : null}
            </div>
          </Can>
        </div>
        <div className="grid content-start gap-4">
          <Card data-testid="segment-counts">
            <CardHeader>
              <CardTitle className="text-base">Contacts now</CardTitle>
              <CardDescription>Worked out again every time the segment is used.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {!valid ? (
                <p className="text-muted-foreground">Complete the rules to see the count.</p>
              ) : preview.isLoading ? (
                <p className="text-muted-foreground">Counting…</p>
              ) : preview.data ? (
                <>
                  <p>
                    <span className="text-2xl font-semibold" data-testid="segment-count">
                      {formatNumber(preview.data.count)}
                    </span>{' '}
                    match · {formatNumber(preview.data.marketable)} can get marketing
                  </p>
                  {preview.data.broken.length ? <p className="text-destructive">A rule {BROKEN_ISSUE_TEXT[preview.data.broken[0]!.issue]}.</p> : null}
                  <ul className="grid gap-1 text-xs text-muted-foreground">
                    {preview.data.sample.map((c) => (
                      <li key={c.id}>
                        {c.name ?? 'Unnamed'} · {c.phone}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-destructive">{errorMessage(preview.error)}</p>
              )}
            </CardContent>
          </Card>
          {!isNew && segment.data?.usedBy.length ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Used by</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1 text-sm">
                {segment.data.usedBy.map((c) => (
                  <Link key={c.id} href={`/campaigns/${c.id}`} className="hover:underline">
                    {c.name} ({c.state.toLowerCase()})
                  </Link>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RuleRow(props: {
  label: string;
  rule: SegmentRule;
  broken?: keyof typeof BROKEN_ISSUE_TEXT;
  tags: Tag[];
  attributes: AttributeDefinition[];
  campaigns: Array<{ id: string; name: string }>;
  onChange: (rule: SegmentRule) => void;
  onRemove: () => void;
}) {
  const { label, rule, onChange } = props;
  return (
    <div className="grid gap-2 rounded-md border p-3" data-testid="segment-rule">
      <div className="flex flex-wrap items-end gap-2">
        <NativeSelect aria-label={`${label} kind`} className="w-48" value={rule.kind} onChange={(e) => onChange(START[e.target.value as SegmentRule['kind']])}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </NativeSelect>
        {rule.kind === 'tag' ? (
          <>
            <NativeSelect aria-label={`${label} has`} className="w-32" value={rule.has ? 'has' : 'not'} onChange={(e) => onChange({ ...rule, has: e.target.value === 'has' })}>
              <option value="has">has</option>
              <option value="not">does not have</option>
            </NativeSelect>
            <NativeSelect aria-label={`${label} tag`} className="w-48" value={rule.tag} onChange={(e) => onChange({ ...rule, tag: e.target.value })}>
              <option value="">Choose a tag</option>
              {props.tags.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </>
        ) : null}
        {rule.kind === 'attr' ? (
          <>
            <NativeSelect aria-label={`${label} attribute`} className="w-44" value={rule.attr} onChange={(e) => onChange({ ...rule, attr: e.target.value })}>
              <option value="">Choose an attribute</option>
              {props.attributes.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label={`${label} operator`} className="w-36" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}>
              {['eq', 'neq', 'contains', 'gt', 'lt', 'before', 'after', 'is_true', 'is_false', 'is_empty', 'is_not_empty'].map((op) => (
                <option key={op} value={op}>
                  {op.replace(/_/g, ' ')}
                </option>
              ))}
            </NativeSelect>
            {!['is_true', 'is_false', 'is_empty', 'is_not_empty'].includes(rule.op) ? (
              <Input aria-label={`${label} value`} className="w-40" value={String(rule.value ?? '')} onChange={(e) => onChange({ ...rule, value: e.target.value })} />
            ) : null}
          </>
        ) : null}
        {rule.kind === 'consent' ? (
          <NativeSelect aria-label={`${label} consent`} className="w-40" value={rule.statuses[0]} onChange={(e) => onChange({ ...rule, statuses: [e.target.value as 'OPTED_IN'] })}>
            <option value="OPTED_IN">Opted in</option>
            <option value="UNKNOWN">Unknown</option>
            <option value="OPTED_OUT">Opted out</option>
          </NativeSelect>
        ) : null}
        {rule.kind === 'lead_source' ? (
          <NativeSelect aria-label={`${label} lead source`} className="w-48" value={rule.sources[0]} onChange={(e) => onChange({ ...rule, sources: [e.target.value as (typeof LEAD_SOURCE_KINDS)[number]] })}>
            {LEAD_SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {LEAD_SOURCE_LABELS[k]}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        {rule.kind === 'added' ? (
          <Input aria-label={`${label} days`} type="number" min={1} max={365} className="w-28" value={rule.days ?? 30} onChange={(e) => onChange({ kind: 'added', days: Number(e.target.value) || 1 })} />
        ) : null}
        {rule.kind === 'last_inbound' ? (
          <>
            <NativeSelect aria-label={`${label} within`} className="w-36" value={rule.within ? 'yes' : 'no'} onChange={(e) => onChange({ ...rule, within: e.target.value === 'yes' })}>
              <option value="yes">within</option>
              <option value="no">not within</option>
            </NativeSelect>
            <Input aria-label={`${label} days`} type="number" min={1} max={365} className="w-28" value={rule.days} onChange={(e) => onChange({ ...rule, days: Number(e.target.value) || 1 })} />
          </>
        ) : null}
        {rule.kind === 'blocked' ? (
          <NativeSelect aria-label={`${label} blocked`} className="w-32" value={rule.blocked ? 'yes' : 'no'} onChange={(e) => onChange({ kind: 'blocked', blocked: e.target.value === 'yes' })}>
            <option value="no">not blocked</option>
            <option value="yes">blocked</option>
          </NativeSelect>
        ) : null}
        {rule.kind === 'behaviour' ? (
          <>
            <NativeSelect aria-label={`${label} did`} className="w-28" value={rule.did ? 'did' : 'not'} onChange={(e) => onChange({ ...rule, did: e.target.value === 'did' })}>
              <option value="did">did</option>
              <option value="not">did not</option>
            </NativeSelect>
            <NativeSelect aria-label={`${label} event`} className="w-36" value={rule.event} onChange={(e) => onChange({ ...rule, event: e.target.value as typeof rule.event })}>
              {['sent', 'delivered', 'read', 'replied', 'clicked', 'failed'].map((ev) => (
                <option key={ev} value={ev}>
                  {ev === 'sent' ? 'get' : ev === 'delivered' ? 'receive' : ev === 'clicked' ? 'click a link in' : ev === 'failed' ? 'fail to get' : ev}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={`${label} scope`}
              className="w-52"
              value={rule.campaignId ?? `days:${rule.days ?? 30}`}
              onChange={(e) => {
                const v = e.target.value;
                const { campaignId: _c, days: _d, ...rest } = rule;
                onChange(v.startsWith('days:') ? { ...rest, days: Number(v.slice(5)) as 7 | 30 | 90 } : { ...rest, campaignId: v });
              }}
            >
              <option value="days:7">any campaign, last 7 days</option>
              <option value="days:30">any campaign, last 30 days</option>
              <option value="days:90">any campaign, last 90 days</option>
              {props.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={props.onRemove}>
          Remove
        </Button>
      </div>
      {props.broken ? <p className="text-xs text-destructive">This rule {BROKEN_ISSUE_TEXT[props.broken]}.</p> : null}
    </div>
  );
}
