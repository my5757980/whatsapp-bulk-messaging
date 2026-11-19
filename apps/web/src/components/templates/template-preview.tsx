import type { TemplateDraft } from '@wbm/shared';
import { ExternalLink, FileText, Image as ImageIcon, Phone, Reply, Video } from 'lucide-react';
import type { TemplateComponent } from '@/lib/types';

/** Replaces {{n}} with the matching sample value (1-based), keeping unknown placeholders visible. */
export function fillSamples(text: string, samples: Array<string | undefined>): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, n: string) => samples[Number(n) - 1]?.trim() || match);
}

const MEDIA_ICON = { IMAGE: ImageIcon, VIDEO: Video, DOCUMENT: FileText } as const;

/** Phone-style preview of a template draft (T142). */
export function TemplatePreview({ draft }: { draft: TemplateDraft }) {
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
        <div className="whitespace-pre-wrap break-words">{fillSamples(draft.body.text || 'Your message text', draft.body.examples ?? [])}</div>
        {draft.footer ? <div className="mt-1 text-xs text-muted-foreground">{draft.footer}</div> : null}
        <div className="mt-1 text-right text-[10px] text-muted-foreground">12:00</div>
      </div>
      {(draft.buttons ?? []).map((b, i) => {
        const Icon = b.type === 'URL' ? ExternalLink : b.type === 'PHONE_NUMBER' ? Phone : Reply;
        return (
          <div key={i} className="mt-1 flex items-center justify-center gap-1 rounded-lg bg-white p-2 text-sm text-sky-700 shadow-sm">
            <Icon className="h-3.5 w-3.5" /> {b.text || 'Button'}
          </div>
        );
      })}
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
