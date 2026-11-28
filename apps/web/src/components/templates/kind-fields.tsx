'use client';

import { TEMPLATE_LIMITS, TTL_RANGES, type AuthTemplateOptions, type CarouselCardDraft, type TemplateButtonDraft, type TemplateDraft } from '@wbm/shared';
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { durationLabel, ttlAppliedByLabel, ttlRangeLabel } from '@/lib/templates';

// Feature 009 (US1 – US4): editor fields for one-time code, carousel and limited-time offer templates and
// the time-to-live. Field ids and labels are stable for the e2e specs.

type Errors = Record<string, string>;
type Update = (patch: Partial<TemplateDraft>) => void;

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const DEFAULT_AUTH: AuthTemplateOptions = { securityNote: true, codeExpiryMinutes: 10, button: 'COPY_CODE', buttonText: 'Copy code' };

export function defaultCard(): CarouselCardDraft {
  return { mediaFormat: 'IMAGE', sampleMediaAssetId: null, bodyText: '', bodyExamples: [], buttons: [{ type: 'QUICK_REPLY', text: 'Tell me more' }] };
}

/** One-time code options (research R2): Meta fixes the wording. */
export function CodeOptions({ draft, update, errors }: { draft: TemplateDraft; update: Update; errors: Errors }) {
  const auth = draft.auth ?? DEFAULT_AUTH;
  const set = (patch: Partial<AuthTemplateOptions>) => update({ auth: { ...auth, ...patch } });
  const apps = auth.apps ?? [];
  return (
    <div className="grid gap-4" data-testid="code-options">
      <p className="rounded-md bg-muted p-3 text-sm">
        WhatsApp writes the message: <strong>&quot;123456 is your verification code.&quot;</strong>, translated into the template&apos;s language. You choose the options below.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={auth.securityNote} onChange={(e) => set({ securityNote: e.target.checked })} />
        Add &quot;For your security, do not share this code.&quot;
      </label>
      <Field id="tpl-code-expiry" label="Code valid for (minutes, optional)" error={errors['auth.codeExpiryMinutes']} hint="Shown as “This code expires in N minutes”. 1 to 90 minutes.">
        <Input
          id="tpl-code-expiry"
          type="number"
          min={TEMPLATE_LIMITS.codeExpiryMinutesMin}
          max={TEMPLATE_LIMITS.codeExpiryMinutesMax}
          value={auth.codeExpiryMinutes ?? ''}
          onChange={(e) => set({ codeExpiryMinutes: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </Field>
      <Field id="tpl-code-button" label="Code button" error={errors['auth.button']}>
        <NativeSelect id="tpl-code-button" value={auth.button} onChange={(e) => set({ button: e.target.value as AuthTemplateOptions['button'] })}>
          <option value="COPY_CODE">Copy code</option>
          <option value="ONE_TAP">One-tap autofill (Android app)</option>
        </NativeSelect>
      </Field>
      <Field id="tpl-code-button-text" label="Button text (optional)" error={errors['auth.buttonText']}>
        <Input id="tpl-code-button-text" value={auth.buttonText ?? ''} maxLength={TEMPLATE_LIMITS.buttonTextMax} onChange={(e) => set({ buttonText: e.target.value || undefined })} />
      </Field>
      {auth.button === 'ONE_TAP' ? (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-xs text-muted-foreground">One-tap fills the code into your Android app. Your app must start WhatsApp&apos;s handshake; phones without the app see a copy-code button.</p>
          <Field id="tpl-code-autofill" label="Autofill text (optional)" error={errors['auth.autofillText']}>
            <Input id="tpl-code-autofill" value={auth.autofillText ?? ''} maxLength={TEMPLATE_LIMITS.buttonTextMax} onChange={(e) => set({ autofillText: e.target.value || undefined })} />
          </Field>
          {errors['auth.apps'] ? (
            <p className="text-xs text-destructive" role="alert">
              {errors['auth.apps']}
            </p>
          ) : null}
          {apps.map((app, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-2">
              <Field id={`tpl-app-${i}-package`} label={`App ${i + 1} package name`} error={errors[`auth.apps.${i}.packageName`]}>
                <Input id={`tpl-app-${i}-package`} value={app.packageName} placeholder="com.example.app" onChange={(e) => set({ apps: apps.map((a, j) => (j === i ? { ...a, packageName: e.target.value } : a)) })} />
              </Field>
              <Field id={`tpl-app-${i}-hash`} label={`App ${i + 1} signature hash`} error={errors[`auth.apps.${i}.signatureHash`]}>
                <Input id={`tpl-app-${i}-hash`} value={app.signatureHash} maxLength={11} onChange={(e) => set({ apps: apps.map((a, j) => (j === i ? { ...a, signatureHash: e.target.value } : a)) })} />
              </Field>
            </div>
          ))}
          {apps.length < TEMPLATE_LIMITS.otpAppsMax ? (
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => set({ apps: [...apps, { packageName: '', signatureHash: '' }] })}>
              Add app
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Time-to-live in minutes, within the category's range (research R8). */
export function TtlField({ draft, update, errors }: { draft: TemplateDraft; update: Update; errors: Errors }) {
  const [min, max] = TTL_RANGES[draft.category];
  const unit = draft.category === 'AUTHENTICATION' ? 60 : draft.category === 'UTILITY' ? 60 : 3600;
  const unitLabel = unit === 60 ? 'minutes' : 'hours';
  return (
    <Field
      id="tpl-ttl"
      label={`Time-to-live in ${unitLabel} (optional)`}
      error={errors.ttlSeconds}
      hint={`${ttlRangeLabel(draft.category)}. ${ttlAppliedByLabel(draft.category)}.${draft.ttlSeconds ? ` Now: ${durationLabel(draft.ttlSeconds)}.` : ''}`}
    >
      <Input
        id="tpl-ttl"
        type="number"
        min={Math.ceil(min / unit)}
        max={Math.floor(max / unit)}
        value={draft.ttlSeconds ? Math.round(draft.ttlSeconds / unit) : ''}
        onChange={(e) => update({ ttlSeconds: e.target.value === '' ? null : Number(e.target.value) * unit })}
      />
    </Field>
  );
}

function CardButtons({ card, index, onChange, errors }: { card: CarouselCardDraft; index: number; onChange: (buttons: TemplateButtonDraft[]) => void; errors: Errors }) {
  const set = (b: number, patch: Partial<TemplateButtonDraft>) => onChange(card.buttons.map((x, j) => (j === b ? { ...x, ...patch } : x)));
  return (
    <div className="grid gap-2">
      {card.buttons.map((button, b) => (
        <div key={b} className="grid gap-2 sm:grid-cols-2">
          <Field id={`tpl-card-${index}-btn-${b}-text`} label={`Card ${index + 1} button ${b + 1} (${button.type === 'URL' ? 'website' : button.type === 'PHONE_NUMBER' ? 'phone' : 'quick reply'})`} error={errors[`cards.${index}.buttons.${b}.text`]}>
            <Input id={`tpl-card-${index}-btn-${b}-text`} value={button.text} maxLength={TEMPLATE_LIMITS.buttonTextMax} onChange={(e) => set(b, { text: e.target.value })} />
          </Field>
          {button.type === 'URL' ? (
            <Field id={`tpl-card-${index}-btn-${b}-url`} label={`Card ${index + 1} button ${b + 1} link`} error={errors[`cards.${index}.buttons.${b}.url`] ?? errors[`cards.${index}.buttons.${b}.urlExample`]}>
              <Input id={`tpl-card-${index}-btn-${b}-url`} value={button.url ?? ''} placeholder="https://shop.example.com/p/{{1}}" onChange={(e) => set(b, { url: e.target.value, urlExample: button.urlExample ?? 'sample' })} />
            </Field>
          ) : null}
          {button.type === 'PHONE_NUMBER' ? (
            <Field id={`tpl-card-${index}-btn-${b}-phone`} label={`Card ${index + 1} button ${b + 1} phone`} error={errors[`cards.${index}.buttons.${b}.phoneNumber`]}>
              <Input id={`tpl-card-${index}-btn-${b}-phone`} value={button.phoneNumber ?? ''} placeholder="+15550100000" onChange={(e) => set(b, { phoneNumber: e.target.value })} />
            </Field>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Carousel cards (research R6): 2–10 cards with one media format; the first card's buttons set the layout
 * for every card, so adding or removing a button changes all cards.
 */
export function CarouselCards({ draft, update, errors }: { draft: TemplateDraft; update: Update; errors: Errors }) {
  const cards = draft.cards ?? [];
  const setCard = (i: number, patch: Partial<CarouselCardDraft>) => update({ cards: cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const upload = useMutation({
    mutationFn: ({ file }: { index: number; file: File }) => {
      const form = new FormData();
      form.set('file', file);
      form.set('purpose', 'TEMPLATE_SAMPLE');
      return api<{ id: string }>('/media', { method: 'POST', body: form });
    },
    onSuccess: (m, vars) => setCard(vars.index, { sampleMediaAssetId: m.id }),
  });
  const format = cards[0]?.mediaFormat ?? 'IMAGE';
  const layout = cards[0]?.buttons ?? [];
  const setLayout = (buttons: TemplateButtonDraft[]) => update({ cards: cards.map((c) => ({ ...c, buttons: buttons.map((b, k) => ({ ...b, text: c.buttons[k]?.type === b.type ? c.buttons[k]!.text : b.text })) })) });
  return (
    <div className="grid gap-4" data-testid="carousel-cards">
      {errors.cards ? (
        <p className="text-xs text-destructive" role="alert">
          {errors.cards}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="tpl-card-format" label="Card media">
          <NativeSelect id="tpl-card-format" value={format} onChange={(e) => update({ cards: cards.map((c) => ({ ...c, mediaFormat: e.target.value as 'IMAGE' | 'VIDEO', sampleMediaAssetId: null })) })}>
            <option value="IMAGE">Image</option>
            <option value="VIDEO">Video</option>
          </NativeSelect>
        </Field>
        <div className="flex flex-wrap items-end gap-2">
          {layout.length < TEMPLATE_LIMITS.cardButtonsMax ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => setLayout([...layout, { type: 'QUICK_REPLY', text: 'Tell me more' }])}>
                Add quick reply to cards
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setLayout([...layout, { type: 'URL', text: 'Shop', url: '', urlExample: 'sample' }])}>
                Add website button to cards
              </Button>
            </>
          ) : null}
          {layout.length ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setLayout(layout.slice(0, -1))}>
              Remove last card button
            </Button>
          ) : null}
        </div>
      </div>
      {cards.map((card, i) => (
        <div key={i} className="grid gap-3 rounded-md border p-3" data-testid={`card-${i + 1}`}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Card {i + 1}</span>
            {cards.length > TEMPLATE_LIMITS.carouselCardsMin ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => update({ cards: cards.filter((_, j) => j !== i) })}>
                Remove card
              </Button>
            ) : null}
          </div>
          <Field id={`tpl-card-${i}-file`} label={`Card ${i + 1} sample ${format.toLowerCase()}`} error={errors[`cards.${i}.sampleMediaAssetId`] ?? errors[`cards.${i}.mediaFormat`]}>
            <Input
              id={`tpl-card-${i}-file`}
              type="file"
              accept={format === 'IMAGE' ? 'image/jpeg,image/png' : 'video/mp4'}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate({ index: i, file });
              }}
            />
            {card.sampleMediaAssetId ? <p className="text-xs text-muted-foreground">Sample uploaded.</p> : null}
          </Field>
          <Field id={`tpl-card-${i}-text`} label={`Card ${i + 1} text (up to 160 characters; all cards or none)`} error={errors[`cards.${i}.bodyText`] ?? errors[`cards.${i}.bodyExamples.0`]}>
            <Input id={`tpl-card-${i}-text`} value={card.bodyText ?? ''} maxLength={TEMPLATE_LIMITS.cardBodyMax} onChange={(e) => setCard(i, { bodyText: e.target.value })} />
          </Field>
          {/\{\{\s*1\s*\}\}/.test(card.bodyText ?? '') ? (
            <Field id={`tpl-card-${i}-sample`} label={`Card ${i + 1} sample for {{1}}`}>
              <Input id={`tpl-card-${i}-sample`} value={card.bodyExamples?.[0] ?? ''} onChange={(e) => setCard(i, { bodyExamples: [e.target.value] })} />
            </Field>
          ) : null}
          <CardButtons card={card} index={i} errors={errors} onChange={(buttons) => setCard(i, { buttons })} />
        </div>
      ))}
      {cards.length < TEMPLATE_LIMITS.carouselCardsMax ? (
        <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => update({ cards: [...cards, { ...defaultCard(), mediaFormat: format, buttons: layout.map((b) => ({ ...b })) }] })}>
          Add card
        </Button>
      ) : null}
    </div>
  );
}

/** Limited-time offer details (research R7); the website button is the template's one button. */
export function OfferFields({ draft, update, errors }: { draft: TemplateDraft; update: Update; errors: Errors }) {
  const offer = draft.offer ?? { offerText: '', showsEndTime: true, codeExample: '' };
  const set = (patch: Partial<typeof offer>) => update({ offer: { ...offer, ...patch } });
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="offer-fields">
      <Field id="tpl-offer-text" label="Offer heading (up to 16 characters)" error={errors['offer.offerText']}>
        <Input id="tpl-offer-text" value={offer.offerText} maxLength={TEMPLATE_LIMITS.offerTextMax} onChange={(e) => set({ offerText: e.target.value })} placeholder="Weekend deal" />
      </Field>
      <Field id="tpl-offer-code" label="Example offer code (up to 15 characters)" error={errors['offer.codeExample']}>
        <Input id="tpl-offer-code" value={offer.codeExample} maxLength={TEMPLATE_LIMITS.offerCodeMax} onChange={(e) => set({ codeExample: e.target.value })} placeholder="WKND20" />
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={offer.showsEndTime} onChange={(e) => set({ showsEndTime: e.target.checked })} />
        Show when the offer ends (a countdown)
      </label>
    </div>
  );
}
