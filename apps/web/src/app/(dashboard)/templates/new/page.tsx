'use client';

import { bodyPlaceholders, validateTemplate, type TemplateButtonDraft, type TemplateDraft, type TemplateHeaderFormat, type TemplateKind } from '@wbm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { CarouselCards, CodeOptions, DEFAULT_AUTH, OfferFields, TtlField, defaultCard } from '@/components/templates/kind-fields';
import { TemplatePreview } from '@/components/templates/template-preview';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { ApiError, api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { growthKeys, type TrackedLinkConfig } from '@/lib/growth';
import { queryKeys } from '@/lib/query';
import { KIND_HINTS, KIND_LABELS } from '@/lib/templates';
import type { Template, WhatsAppNumber } from '@/lib/types';

/** Sample code for a tracked link button; each recipient gets their own code when a campaign sends (feature 005). */
const SAMPLE_LINK_CODE = 'AbCdEf1234';

const EMPTY: TemplateDraft = {
  wabaId: '',
  name: '',
  language: 'en_US',
  category: 'MARKETING',
  header: null,
  body: { text: '', examples: [] },
  footer: '',
  buttons: [],
};

/** Template editor with live preview and field errors from the shared rules (T142). */
export default function NewTemplatePage() {
  return (
    <RequirePermission permission="templates.manage">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Editor />
      </Suspense>
    </RequirePermission>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p className="text-xs text-destructive" role="alert">
      {message}
    </p>
  ) : null;
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <FieldError message={error} />
    </div>
  );
}

function Editor() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const fromId = params.get('from');
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [mediaInfo, setMediaInfo] = useState<{ mimeType: string; sizeBytes: number } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const linkConfig = useQuery({ queryKey: growthKeys.linkConfig, queryFn: () => api<TrackedLinkConfig>('/tracked-links/config'), staleTime: 5 * 60_000 });
  const trackedUrl = linkConfig.data?.enabled ? linkConfig.data.buttonUrl : null;
  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of numbers.data ?? []) if (n.connectionStatus === 'CONNECTED' && !seen.has(n.wabaId)) seen.set(n.wabaId, `${n.verifiedName} (${n.wabaId})`);
    return [...seen.entries()];
  }, [numbers.data]);

  // "Duplicate & edit": prefill from POST /templates/{id}/duplicate.
  const prefill = useQuery({
    queryKey: ['template-duplicate', fromId],
    queryFn: () => api<TemplateDraft>(`/templates/${fromId}/duplicate`, { method: 'POST' }),
    enabled: Boolean(fromId),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (prefill.data) setDraft({ ...EMPTY, ...prefill.data, footer: prefill.data.footer ?? '', buttons: prefill.data.buttons ?? [] });
  }, [prefill.data]);
  useEffect(() => {
    if (!draft.wabaId && accounts.length === 1) setDraft((d) => ({ ...d, wabaId: accounts[0]![0] }));
  }, [accounts, draft.wabaId]);

  const clientIssues = useMemo(() => validateTemplate({ ...draft, footer: draft.footer || null }, mediaInfo), [draft, mediaInfo]);
  const errors = useMemo(() => {
    const map: Record<string, string> = { ...serverErrors };
    if (touched) for (const i of clientIssues) map[i.field] ??= i.issue;
    if (touched && !draft.wabaId) map.wabaId = 'choose the WhatsApp Business Account';
    return map;
  }, [clientIssues, serverErrors, touched, draft.wabaId]);
  const variables = bodyPlaceholders(draft.body.text).filter((v) => /^\d+$/.test(v));

  const update = (patch: Partial<TemplateDraft>) => {
    setServerErrors({});
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setButton = (i: number, patch: Partial<TemplateButtonDraft>) =>
    update({ buttons: (draft.buttons ?? []).map((b, j) => (j === i ? { ...b, ...patch } : b)) });

  function insertVariable() {
    const next = variables.length + 1;
    const el = bodyRef.current;
    const text = draft.body.text;
    const at = el ? el.selectionStart : text.length;
    update({ body: { ...draft.body, text: `${text.slice(0, at)}{{${next}}}${text.slice(at)}` } });
  }

  const uploadMedia = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      form.set('purpose', 'TEMPLATE_SAMPLE');
      return api<{ id: string; mimeType: string; sizeBytes: number }>('/media', { method: 'POST', body: form });
    },
    onSuccess: (m) => {
      setMediaInfo({ mimeType: m.mimeType, sizeBytes: m.sizeBytes });
      if (draft.header) update({ header: { ...draft.header, mediaAssetId: m.id } });
    },
    onError: (e) => setFormError(errorMessage(e)),
  });

  const submit = useMutation({
    mutationFn: () => {
      const payload = {
        ...draft,
        kind,
        footer: kind === 'STANDARD' && draft.footer?.trim() ? draft.footer.trim() : null,
        body: { text: draft.body.text, examples: (draft.body.examples ?? []).slice(0, variables.length) },
      };
      return api<Template>('/templates', { method: 'POST', json: payload });
    },
    onSuccess: (t) => {
      toast.success('Template submitted to Meta for review');
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
      router.push(`/templates/${t.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.details?.length) setServerErrors(Object.fromEntries(e.details.map((d) => [d.field, d.issue])));
      setFormError(errorMessage(e));
    },
  });

  function onSubmit() {
    setTouched(true);
    setFormError(null);
    if (clientIssues.length || !draft.wabaId) {
      setFormError('Fix the highlighted fields before submitting.');
      return;
    }
    submit.mutate();
  }

  const headerFormat = draft.header?.format ?? 'NONE';
  const buttons = draft.buttons ?? [];
  const kind: TemplateKind = draft.kind ?? 'STANDARD';
  /** Feature 009: each kind starts from its own defaults. */
  function chooseKind(next: TemplateKind) {
    setMediaInfo(null);
    const common = { kind: next, header: null, footer: '', auth: null, cards: null, offer: null, ttlSeconds: null } satisfies Partial<TemplateDraft>;
    if (next === 'AUTHENTICATION') update({ ...common, category: 'AUTHENTICATION', body: { text: '', examples: [] }, buttons: [], auth: DEFAULT_AUTH, ttlSeconds: 600 });
    else if (next === 'CAROUSEL') update({ ...common, category: 'MARKETING', buttons: [], cards: [defaultCard(), defaultCard()] });
    else if (next === 'LIMITED_TIME_OFFER') update({ ...common, category: 'MARKETING', buttons: [{ type: 'URL', text: 'Shop now', url: '' }], offer: { offerText: '', showsEndTime: true, codeExample: '' } });
    else update({ ...common, category: 'MARKETING' });
  }

  return (
    <div className="grid gap-6">
      <div>
        <Link href="/templates" className="text-sm text-muted-foreground hover:underline">
          ← Templates
        </Link>
        <h1 className="text-2xl font-semibold">{fromId ? (params.get('draft') ? 'Review template draft' : 'Duplicate template') : 'New template'}</h1>
        <p className="text-sm text-muted-foreground">Meta reviews every template, usually within minutes. Variables need sample values.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Basics</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field id="tpl-account" label="Account" error={errors.wabaId}>
                <NativeSelect id="tpl-account" value={draft.wabaId ?? ''} onChange={(e) => update({ wabaId: e.target.value })}>
                  <option value="">Choose an account…</option>
                  {accounts.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id="tpl-name" label="Template name" error={errors.name}>
                <Input id="tpl-name" value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="summer_offer_2026" onBlur={() => setTouched(true)} />
              </Field>
              <Field id="tpl-kind" label="Type" error={errors.kind}>
                <NativeSelect id="tpl-kind" value={kind} onChange={(e) => chooseKind(e.target.value as TemplateKind)}>
                  {(Object.keys(KIND_LABELS) as TemplateKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </NativeSelect>
                <p className="text-xs text-muted-foreground">{KIND_HINTS[kind]}</p>
              </Field>
              <Field id="tpl-category" label="Category" error={errors.category}>
                <NativeSelect id="tpl-category" value={draft.category} disabled={kind !== 'STANDARD'} onChange={(e) => update({ category: e.target.value as TemplateDraft['category'], ttlSeconds: null })}>
                  <option value="MARKETING">Marketing</option>
                  <option value="UTILITY">Utility</option>
                  {kind === 'AUTHENTICATION' ? <option value="AUTHENTICATION">Authentication</option> : null}
                </NativeSelect>
              </Field>
              <Field id="tpl-language" label="Language" error={errors.language}>
                <Input id="tpl-language" value={draft.language} onChange={(e) => update({ language: e.target.value })} placeholder="en_US" />
              </Field>
              <TtlField draft={draft} update={update} errors={errors} />
            </CardContent>
          </Card>

          {kind === 'AUTHENTICATION' ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Code options</CardTitle>
              </CardHeader>
              <CardContent>
                <CodeOptions draft={draft} update={update} errors={errors} />
              </CardContent>
            </Card>
          ) : null}

          {kind !== 'AUTHENTICATION' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Content</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {kind !== 'CAROUSEL' ? (
              <Field id="tpl-header" label="Header" error={errors['header.text'] ?? errors['header.mediaAssetId']}>
                <NativeSelect
                  id="tpl-header"
                  value={headerFormat}
                  onChange={(e) => {
                    const value = e.target.value as 'NONE' | TemplateHeaderFormat;
                    setMediaInfo(null);
                    update({ header: value === 'NONE' ? null : { format: value, text: '' } });
                  }}
                >
                  <option value="NONE">None</option>
                  {kind === 'STANDARD' ? <option value="TEXT">Text</option> : null}
                  <option value="IMAGE">Image</option>
                  <option value="VIDEO">Video</option>
                  {kind === 'STANDARD' ? <option value="DOCUMENT">Document</option> : null}
                </NativeSelect>
              </Field>
              ) : null}
              {draft.header?.format === 'TEXT' ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="tpl-header-text" label="Header text (up to 60 characters)" error={errors['header.text']}>
                    <Input id="tpl-header-text" value={draft.header.text ?? ''} onChange={(e) => update({ header: { ...draft.header!, text: e.target.value } })} />
                  </Field>
                  {/\{\{\s*1\s*\}\}/.test(draft.header.text ?? '') ? (
                    <Field id="tpl-header-sample" label="Sample for header {{1}}" error={errors['header.textExample']}>
                      <Input id="tpl-header-sample" value={draft.header.textExample ?? ''} onChange={(e) => update({ header: { ...draft.header!, textExample: e.target.value } })} />
                    </Field>
                  ) : null}
                </div>
              ) : null}
              {draft.header && draft.header.format !== 'TEXT' ? (
                <Field id="tpl-header-file" label={`Sample ${draft.header.format.toLowerCase()} for Meta's review`} error={errors['header.mediaAssetId']}>
                  <Input
                    id="tpl-header-file"
                    type="file"
                    accept={draft.header.format === 'IMAGE' ? 'image/jpeg,image/png' : draft.header.format === 'VIDEO' ? 'video/mp4' : 'application/pdf'}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadMedia.mutate(file);
                    }}
                  />
                  {uploadMedia.isPending ? <p className="text-xs text-muted-foreground">Uploading…</p> : null}
                  {draft.header.mediaAssetId && !uploadMedia.isPending ? <p className="text-xs text-muted-foreground">Sample uploaded.</p> : null}
                </Field>
              ) : null}

              <Field id="tpl-body" label="Message text" error={errors['body.text']}>
                <textarea
                  id="tpl-body"
                  ref={bodyRef}
                  className="min-h-32 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={draft.body.text}
                  onChange={(e) => update({ body: { ...draft.body, text: e.target.value } })}
                  maxLength={1100}
                  placeholder="Hi {{1}}, your order is on its way."
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <Button type="button" variant="outline" size="sm" onClick={insertVariable}>
                    Add variable
                  </Button>
                  <span>{draft.body.text.length} / 1024</span>
                </div>
              </Field>
              {variables.length ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {variables.map((_, i) => (
                    <Field key={i} id={`tpl-sample-${i + 1}`} label={`Sample for {{${i + 1}}}`} error={errors[`body.examples.${i}`]}>
                      <Input
                        id={`tpl-sample-${i + 1}`}
                        value={draft.body.examples?.[i] ?? ''}
                        onChange={(e) => {
                          const examples = [...(draft.body.examples ?? [])];
                          examples[i] = e.target.value;
                          update({ body: { ...draft.body, examples } });
                        }}
                      />
                    </Field>
                  ))}
                </div>
              ) : null}
              {kind === 'STANDARD' ? (
              <Field id="tpl-footer" label="Footer (optional)" error={errors.footer}>
                <Input id="tpl-footer" value={draft.footer ?? ''} onChange={(e) => update({ footer: e.target.value })} placeholder="Reply STOP to unsubscribe" />
              </Field>
              ) : null}
              {kind === 'LIMITED_TIME_OFFER' ? <OfferFields draft={draft} update={update} errors={errors} /> : null}
            </CardContent>
          </Card>
          ) : null}

          {kind === 'CAROUSEL' ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cards</CardTitle>
              </CardHeader>
              <CardContent>
                <CarouselCards draft={draft} update={update} errors={errors} />
              </CardContent>
            </Card>
          ) : null}

          {kind === 'STANDARD' || kind === 'LIMITED_TIME_OFFER' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{kind === 'LIMITED_TIME_OFFER' ? 'Website button (the copy-code button is added for you)' : 'Buttons (optional)'}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <FieldError message={errors.buttons} />
              {buttons.map((b, i) => {
                const tracked = b.type === 'URL' && trackedUrl !== null && b.url === trackedUrl;
                return (
                <div key={i} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" data-testid="template-button">
                  <div className="text-sm font-medium sm:col-span-2">
                    Button {i + 1}:{' '}
                    {tracked ? 'Tracked link' : b.type === 'URL' ? 'Website' : b.type === 'PHONE_NUMBER' ? 'Phone call' : b.type === 'CATALOG' ? 'View catalog' : b.type === 'MPM' ? 'Product list' : 'Quick reply'}
                  </div>
                  {b.type === 'CATALOG' || b.type === 'MPM' ? (
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      {b.type === 'CATALOG' ? 'Opens your Meta catalog.' : 'Shows up to 30 products in sections.'} You choose the products when you prepare a campaign. Marketing
                      templates only, and this must be the only button.
                    </p>
                  ) : null}
                  {tracked ? (
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      Each person gets their own short link on your company&apos;s address, so campaign results show who clicked. You choose where it
                      goes when you prepare a campaign or a drip.
                    </p>
                  ) : null}
                  <Field id={`tpl-btn-${i}-text`} label={`Button ${i + 1} text`} error={errors[`buttons.${i}.text`]}>
                    <Input id={`tpl-btn-${i}-text`} value={b.text} onChange={(e) => setButton(i, { text: e.target.value })} maxLength={40} />
                  </Field>
                  {b.type === 'URL' ? (
                    <>
                      <Field id={`tpl-btn-${i}-url`} label={`Button ${i + 1} link`} error={errors[`buttons.${i}.url`]}>
                        <Input
                          id={`tpl-btn-${i}-url`}
                          value={b.url ?? ''}
                          readOnly={tracked}
                          onChange={(e) => setButton(i, { url: e.target.value })}
                          placeholder="https://example.com/offers/{{1}}"
                        />
                      </Field>
                      {!tracked && /\{\{\s*1\s*\}\}$/.test(b.url ?? '') ? (
                        <Field id={`tpl-btn-${i}-sample`} label={`Button ${i + 1} sample`} error={errors[`buttons.${i}.urlExample`]}>
                          <Input id={`tpl-btn-${i}-sample`} value={b.urlExample ?? ''} onChange={(e) => setButton(i, { urlExample: e.target.value })} placeholder="summer" />
                        </Field>
                      ) : null}
                    </>
                  ) : null}
                  {b.type === 'PHONE_NUMBER' ? (
                    <Field id={`tpl-btn-${i}-phone`} label={`Button ${i + 1} phone number`} error={errors[`buttons.${i}.phoneNumber`]}>
                      <Input id={`tpl-btn-${i}-phone`} value={b.phoneNumber ?? ''} onChange={(e) => setButton(i, { phoneNumber: e.target.value })} placeholder="+15550100000" />
                    </Field>
                  ) : null}
                  <div className="sm:col-span-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => update({ buttons: buttons.filter((_, j) => j !== i) })}>
                      Remove button
                    </Button>
                  </div>
                </div>
                );
              })}
              {kind === 'STANDARD' ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => update({ buttons: [...buttons, { type: 'QUICK_REPLY', text: '' }] })}>
                  Add quick reply
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => update({ buttons: [...buttons, { type: 'URL', text: '', url: '' }] })}>
                  Add website button
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!trackedUrl}
                  title={trackedUrl ? undefined : 'Link tracking is not set up on this server'}
                  onClick={() => trackedUrl && update({ buttons: [...buttons, { type: 'URL', text: '', url: trackedUrl, urlExample: SAMPLE_LINK_CODE }] })}
                >
                  Add tracked link button
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => update({ buttons: [...buttons, { type: 'PHONE_NUMBER', text: '', phoneNumber: '' }] })}>
                  Add phone button
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => update({ category: 'MARKETING', buttons: [{ type: 'CATALOG', text: 'View catalog' }] })}>
                  Add catalog button
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => update({ category: 'MARKETING', buttons: [{ type: 'MPM', text: 'View items' }] })}>
                  Add product list button
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!trackedUrl}
                  title={trackedUrl ? 'A website button to this platform’s pay links: each customer gets their own payment link' : 'Link tracking is not set up on this server'}
                  onClick={() => trackedUrl && update({ buttons: [...buttons, { type: 'URL', text: 'Pay now', url: trackedUrl.replace(/\{\{1\}\}$/, 'p/{{1}}'), urlExample: trackedUrl.replace(/\{\{1\}\}$/, `p/${SAMPLE_LINK_CODE}`) }] })}
                >
                  Add pay link button
                </Button>
              </div>
              ) : null}
            </CardContent>
          </Card>
          ) : null}

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <div>
            <Button onClick={onSubmit} disabled={submit.isPending}>
              {submit.isPending ? 'Submitting…' : 'Submit for review'}
            </Button>
          </div>
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <TemplatePreview draft={draft} />
        </div>
      </div>
    </div>
  );
}
