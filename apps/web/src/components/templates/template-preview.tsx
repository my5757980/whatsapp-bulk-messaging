import type { TemplateDraft } from '@wbm/shared';
import { Copy, ExternalLink, FileText, Image as ImageIcon, Phone, Reply, Timer, Video } from 'lucide-react';
import type { TemplateComponent } from '@/lib/types';

/** Replaces {{n}} with the matching sample value (1-based), keeping unknown placeholders visible. */
export function fillSamples(text: string, samples: Array<string | undefined>): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, n: string) => samples[Number(n) - 1]?.trim() || match);
}

const MEDIA_ICON = { IMAGE: ImageIcon, VIDEO: Video, DOCUMENT: FileText } as const;

function ButtonRow({ icon: Icon, text }: { icon: typeof Reply; text: string }) {
  return (
    <div className="mt-1 flex items-center justify-center gap-1 rounded-lg bg-white p-2 text-sm text-sky-700 shadow-sm">
      <Icon className="h-3.5 w-3.5" /> {text}
    </div>
  );
}

/** Feature 009: one-time code templates, with Meta's fixed wording. */
function CodePreview({ draft }: { draft: TemplateDraft }) {
  const auth = draft.auth;
  return (
    <div className="mx-auto w-full max-w-xs rounded-3xl border-8 border-foreground/80 bg-[#e5ddd5] p-3 shadow-lg" aria-label="Message preview">
      <div className="rounded-lg bg-white p-2 text-sm shadow-sm">
        <div>
          <strong>123456</strong> is your verification code.{auth?.securityNote ? ' For your security, do not share this code.' : ''}
        </div>
        {auth?.codeExpiryMinutes ? <div className="mt-1 text-xs text-muted-foreground">This code expires in {auth.codeExpiryMinutes} minutes.</div> : null}
      </div>
      <ButtonRow icon={Copy} text={auth?.button === 'ONE_TAP' ? auth.autofillText || 'Autofill' : auth?.buttonText || 'Copy code'} />
    </div>
  );
}

/** Feature 009: carousel templates, the message and the cards side by side. */
function CarouselPreview({ draft }: { draft: TemplateDraft }) {
  return (
    <div className="mx-auto w-full max-w-xs rounded-3xl border-8 border-foreground/80 bg-[#e5ddd5] p-3 shadow-lg" aria-label="Message preview">
      <div className="rounded-lg bg-white p-2 text-sm shadow-sm">{fillSamples(draft.body.text || 'Your message text', draft.body.examples ?? [])}</div>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1" data-testid="carousel-preview">
        {(draft.cards ?? []).map((card, i) => {
          const Icon = card.mediaFormat === 'VIDEO' ? Video : ImageIcon;
          return (
            <div key={i} className="w-40 shrink-0 rounded-lg bg-white p-2 text-xs shadow-sm">
              <div className="mb-1 flex h-20 items-center justify-center rounded bg-muted text-muted-foreground">
                <Icon className="h-6 w-6" />
              </div>
              {card.bodyText ? <div className="mb-1">{fillSamples(card.bodyText, card.bodyExamples ?? [])}</div> : null}
              {card.buttons.map((b, j) => (
                <div key={j} className="mt-1 rounded border p-1 text-center text-sky-700">
                  {b.text || 'Button'}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Phone-style preview of a template draft (T142). */
export function TemplatePreview({ draft }: { draft: TemplateDraft }) {
  if (draft.kind === 'AUTHENTICATION') return <CodePreview draft={draft} />;
  if (draft.kind === 'CAROUSEL') return <CarouselPreview draft={draft} />;
  const header = draft.header;
  const MediaIcon = header && header.format !== 'TEXT' ? MEDIA_ICON[header.format] : null;
  return (
    <div className="mx-auto w-full max-w-xs rounded-3xl border-8 border-foreground/80 bg-[#e5ddd5] p-3 shadow-lg" aria-label="Message preview">
      <div className="rounded-lg bg-white p-2 text-sm shadow-sm">
        {MediaIcon ? (
          <div className="mb-2 flex h-28 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <MediaIcon className="h-8 w-8" />
          </div>
        ) : null}
        {header?.format === 'TEXT' && header.text ? <div className="mb-1 font-semibold">{fillSamples(header.text, [header.textExample])}</div> : null}
        {draft.kind === 'LIMITED_TIME_OFFER' && draft.offer ? (
          <div className="mb-1 flex items-center gap-1 font-semibold">
            {draft.offer.offerText || 'Offer'}
            {draft.offer.showsEndTime ? (
              <span className="ml-auto flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <Timer className="h-3 w-3" /> Ends in 2 days
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="whitespace-pre-wrap break-words">{fillSamples(draft.body.text || 'Your message text', draft.body.examples ?? [])}</div>
        {draft.footer ? <div className="mt-1 text-xs text-muted-foreground">{draft.footer}</div> : null}
        <div className="mt-1 text-right text-[10px] text-muted-foreground">12:00</div>
      </div>
      {draft.kind === 'LIMITED_TIME_OFFER' ? <ButtonRow icon={Copy} text={`Copy code ${draft.offer?.codeExample ?? ''}`.trim()} /> : null}
      {(draft.buttons ?? []).map((b, i) => (
        <ButtonRow key={i} icon={b.type === 'URL' ? ExternalLink : b.type === 'PHONE_NUMBER' ? Phone : Reply} text={b.text || 'Button'} />
      ))}
    </div>
  );
}

/** Converts stored Meta components back into a draft for previewing an existing template. */
export function componentsToDraft(components: TemplateComponent[]): TemplateDraft {
  const find = (type: string) => components.find((c) => c.type.toUpperCase() === type);
  const header = find('HEADER') as (TemplateComponent & { example?: { header_text?: string[] } }) | undefined;
  const body = find('BODY') as (TemplateComponent & { example?: { body_text?: string[][] } }) | undefined;
  const format = (header?.format?.toUpperCase() ?? 'TEXT') as 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  return {
    name: '',
    language: '',
    category: 'UTILITY',
    header: header ? { format, text: header.text ?? '', textExample: header.example?.header_text?.[0] } : null,
    body: { text: body?.text ?? '', examples: body?.example?.body_text?.[0] ?? [] },
    footer: find('FOOTER')?.text ?? null,
    buttons: (find('BUTTONS')?.buttons ?? []).map((b) => ({
      type: b.type.toUpperCase() === 'URL' ? 'URL' : b.type.toUpperCase() === 'PHONE_NUMBER' ? 'PHONE_NUMBER' : 'QUICK_REPLY',
      text: b.text ?? '',
    })),
  };
}
