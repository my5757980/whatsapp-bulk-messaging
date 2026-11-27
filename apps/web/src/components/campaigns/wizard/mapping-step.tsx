'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { destinationProblem } from '@wbm/shared';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { growthKeys, type TrackedLinkConfig, type TrackedLinkSet } from '@/lib/growth';
import { queryKeys } from '@/lib/query';
import type { CampaignDetail, CampaignPaymentConfig, Estimate, Template, VariableSource, VariableSourceKind } from '@/lib/types';
import { PAYMENT_VARIABLE_KEYS, PaymentConfigCard, payLinkButtonKey, paymentConfigComplete } from './payment-config';
import { ProductChoicesCard, choicesComplete, choicesFrom, choicesMapping, productButtonKind, type ProductChoices } from './product-choices';

const SOURCES: Array<{ value: VariableSourceKind; label: string }> = [
  { value: 'column', label: 'Uploaded column' },
  { value: 'field', label: 'Contact field' },
  { value: 'attribute', label: 'Contact attribute' },
  { value: 'static', label: 'Same text for everyone' },
];

/** A tracked link (feature 005): where it goes and whether campaign tags are added. */
interface TrackedChoice {
  destination: string;
  addCampaignTags: boolean;
}

function isComplete(m: VariableSource | undefined): boolean {
  if (!m) return false;
  return m.source === 'static' ? Boolean(m.value?.trim()) : Boolean(m.key?.trim());
}

/**
 * Step 3 (T110): map each template variable to a column, field, attribute or static text. A
 * variable that can carry a tracked link can instead go to a destination address (feature 005,
 * FR-001); a button on the tracked-link address must.
 */
export function MappingStep({ campaign, onBack, onDone }: { campaign: CampaignDetail; onBack: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const template = useQuery({
    queryKey: ['template', campaign.templateId],
    queryFn: () => api<Template>(`/templates/${campaign.templateId}`),
    enabled: Boolean(campaign.templateId),
  });
  const trackedLinks = useQuery({ queryKey: growthKeys.trackedLinks(campaign.id), queryFn: () => api<TrackedLinkSet>(`/campaigns/${campaign.id}/tracked-links`) });
  const linkConfig = useQuery({ queryKey: growthKeys.linkConfig, queryFn: () => api<TrackedLinkConfig>('/tracked-links/config'), staleTime: 5 * 60_000 });
  const uploaded = campaign.audienceType === 'UPLOAD';
  // Retarget drafts can reuse the original upload's columns (typed by name).
  const allowColumn = uploaded || campaign.audienceType === 'RETARGET';
  const columns = uploaded ? (campaign.audienceUpload?.columns ?? []) : [];
  const defaultSource: VariableSourceKind = uploaded ? 'column' : 'field';
  const [payment, setPayment] = useState<CampaignPaymentConfig | null>(campaign.paymentConfig ?? null);
  // Feature 008: a template with a pay link button can ask every recipient to pay.
  const payKey = payLinkButtonKey(template.data, linkConfig.data?.baseUrl);
  const paying = Boolean(payKey && payment);
  const sources = [...(allowColumn ? SOURCES : SOURCES.filter((s) => s.value !== 'column')), ...(paying ? [{ value: 'payment' as const, label: 'Payment request' }] : [])];
  const [mapping, setMapping] = useState<Record<string, VariableSource>>(campaign.variableMapping ?? {});
  // Feature 008 (US5): catalog and product list templates carry product choices.
  const productKind = productButtonKind(template.data);
  const [choices, setChoices] = useState<ProductChoices>(() => choicesFrom(campaign.variableMapping ?? {}));
  const [tracked, setTracked] = useState<Record<string, TrackedChoice> | null>(null);
  const [previews, setPreviews] = useState<Estimate['previews'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const variables = template.data?.variables ?? [];
  const trackable = new Map((trackedLinks.data?.trackable ?? []).map((t) => [t.variableKey, t]));

  // Saved tracked links; tracked buttons always need a destination, so they start as tracked links.
  useEffect(() => {
    if (tracked !== null || !trackedLinks.data) return;
    const initial: Record<string, TrackedChoice> = {};
    for (const link of trackedLinks.data.links) initial[link.variableKey] = { destination: link.destination, addCampaignTags: link.addCampaignTags };
    for (const t of trackedLinks.data.trackable) if (t.kind === 'URL_BUTTON' && t.trackable) initial[t.variableKey] ??= { destination: '', addCampaignTags: false };
    setTracked(initial);
  }, [tracked, trackedLinks.data]);

  const update = (key: string, patch: Partial<VariableSource>) =>
    setMapping((current) => ({ ...current, [key]: { source: defaultSource, ...current[key], ...patch } }));
  const setTrackedChoice = (key: string, choice: TrackedChoice | null) =>
    setTracked((current) => {
      const next = { ...(current ?? {}) };
      if (choice) next[key] = choice;
      else delete next[key];
      return next;
    });
  const destinationOk = (value: string) => !destinationProblem(value.trim(), linkConfig.data?.baseUrl ?? undefined);

  const save = useMutation({
    mutationFn: async (next: 'preview' | 'continue') => {
      const links = tracked ?? {};
      const clean = Object.fromEntries(
        variables
          .filter(({ key }) => !links[key] && !(paying && key === payKey))
          .map(({ key }) => {
            const m = mapping[key] ?? { source: defaultSource };
            const fallback = m.fallback?.trim() ? m.fallback.trim() : null;
            return [key, m.source === 'static' ? { source: 'static', value: m.value ?? '', fallback } : { source: m.source, key: m.key ?? '', fallback }];
          }),
      );
      const withProducts = productKind ? { ...clean, $products: choicesMapping(productKind, choices) } : clean;
      await api(`/campaigns/${campaign.id}`, { method: 'PATCH', json: { variableMapping: withProducts, paymentConfig: payKey ? payment : null } });
      await api(`/campaigns/${campaign.id}/tracked-links`, {
        method: 'PUT',
        json: { links: Object.entries(links).map(([variableKey, c]) => ({ variableKey, destination: c.destination.trim(), addCampaignTags: c.addCampaignTags })) },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.campaign(campaign.id) });
      await queryClient.invalidateQueries({ queryKey: growthKeys.trackedLinks(campaign.id) });
      if (next === 'preview') setPreviews((await api<Estimate>(`/campaigns/${campaign.id}/estimate`, { method: 'POST' })).previews);
      return next;
    },
    onSuccess: (next) => {
      if (next === 'continue') onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (template.isLoading || trackedLinks.isLoading) return <p className="text-sm text-muted-foreground">Loading template…</p>;
  const body = template.data?.components.find((c) => c.type.toUpperCase() === 'BODY')?.text ?? '';
  const ready =
    paymentConfigComplete(payKey ? payment : null) &&
    choicesComplete(productKind, choices) &&
    variables.every(({ key }) => {
      if (paying && key === payKey) return true;
      const link = tracked?.[key];
      if (link) return destinationOk(link.destination);
      return isComplete(mapping[key]) && (paying || mapping[key]?.source !== 'payment');
    });

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="rounded-md border bg-muted/40 p-4 text-sm">
        <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Template text</div>
        <p className="whitespace-pre-wrap">{body}</p>
      </div>
      {!variables.length ? <p className="text-sm text-muted-foreground">This template has no variables. Continue to review.</p> : null}
      {payKey ? <PaymentConfigCard value={payment} onChange={setPayment} /> : null}
      {productKind ? <ProductChoicesCard kind={productKind} value={choices} onChange={setChoices} /> : null}
      {variables.map(({ key, example }) => {
        if (paying && key === payKey) {
          return (
            <div key={key} className="grid gap-1 rounded-md border p-4" data-testid={`mapping-${key}`}>
              <div className="font-mono text-sm font-medium">{key}</div>
              <div className="text-sm text-muted-foreground">Pay link button: each recipient gets their own link.</div>
            </div>
          );
        }
        const m = mapping[key] ?? { source: defaultSource };
        const id = key.replace(/\W/g, '-');
        const t = trackable.get(key);
        const link = tracked?.[key];
        const mustTrack = t?.kind === 'URL_BUTTON' && t.trackable;
        return (
          <div key={key} className="grid gap-3 rounded-md border p-4 sm:grid-cols-[10rem_1fr_1fr_1fr]" data-testid={`mapping-${key}`}>
            <div>
              <div className="font-mono text-sm font-medium">{key}</div>
              {example ? <div className="text-xs text-muted-foreground">e.g. {example}</div> : null}
              {mustTrack ? <div className="text-xs text-muted-foreground">Tracked link button</div> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-source`}>Source</Label>
              <NativeSelect
                id={`${id}-source`}
                value={link ? 'tracked' : m.source}
                onChange={(e) => {
                  if (e.target.value === 'tracked') setTrackedChoice(key, { destination: '', addCampaignTags: false });
                  else {
                    setTrackedChoice(key, null);
                    update(key, { source: e.target.value as VariableSourceKind, key: '', value: '' });
                  }
                }}
              >
                {(mustTrack ? [] : sources).map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
                {t?.trackable ? <option value="tracked">Tracked link</option> : null}
              </NativeSelect>
            </div>
            {link ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-value`}>Destination address</Label>
                  <Input
                    id={`${id}-value`}
                    value={link.destination}
                    onChange={(e) => setTrackedChoice(key, { ...link, destination: e.target.value })}
                    placeholder="https://shop.example.com/sale"
                  />
                  {link.destination.trim() && !destinationOk(link.destination) ? (
                    <p className="text-xs text-destructive">Enter a full address starting with https://</p>
                  ) : link.destination.trim().startsWith('http://') ? (
                    <p className="text-xs text-amber-700">Not a secure address (http).</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 self-end pb-2">
                  <input
                    id={`${id}-tags`}
                    type="checkbox"
                    className="h-4 w-4"
                    checked={link.addCampaignTags}
                    onChange={(e) => setTrackedChoice(key, { ...link, addCampaignTags: e.target.checked })}
                  />
                  <Label htmlFor={`${id}-tags`}>Add campaign tags</Label>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-value`}>{m.source === 'static' ? 'Text' : m.source === 'attribute' ? 'Attribute key' : 'Value from'}</Label>
                  {m.source === 'column' && !columns.length ? (
                    <Input id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })} placeholder="column name" />
                  ) : m.source === 'column' ? (
                    <NativeSelect id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })}>
                      <option value="">Choose a column…</option>
                      {columns.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : m.source === 'field' ? (
                    <NativeSelect id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })}>
                      <option value="">Choose a field…</option>
                      <option value="name">Name</option>
                      <option value="phone">Phone</option>
                    </NativeSelect>
                  ) : m.source === 'attribute' ? (
                    <Input id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })} placeholder="city" />
                  ) : m.source === 'payment' ? (
                    <NativeSelect id={`${id}-value`} value={m.key ?? ''} onChange={(e) => update(key, { key: e.target.value })}>
                      <option value="">Choose…</option>
                      {PAYMENT_VARIABLE_KEYS.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    <Input id={`${id}-value`} value={m.value ?? ''} onChange={(e) => update(key, { value: e.target.value })} />
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-fallback`}>Fallback if empty</Label>
                  <Input id={`${id}-fallback`} value={m.fallback ?? ''} onChange={(e) => update(key, { fallback: e.target.value })} placeholder="there" />
                </div>
              </>
            )}
          </div>
        );
      })}
      {previews ? (
        <div className="grid gap-2" data-testid="previews">
          <div className="text-sm font-medium">Preview</div>
          {previews.map((p) => (
            <div key={p.phoneMasked} className="rounded-md border p-3 text-sm">
              <div className="text-xs text-muted-foreground">{p.phoneMasked}</div>
              <div>{p.text}</div>
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button variant="secondary" onClick={() => save.mutate('preview')} disabled={!ready || save.isPending}>
          Preview
        </Button>
        <Button onClick={() => save.mutate('continue')} disabled={!ready || save.isPending}>
          Save and continue
        </Button>
      </div>
    </div>
  );
}
