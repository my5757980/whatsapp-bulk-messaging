'use client';

import { REJECTION_REASONS, TEMPLATE_GUIDELINES, type GuidelineSection, type TemplateKind } from '@wbm/shared';

/**
 * Guidelines next to the template editor (feature 009 US7, FR-027): the sections that matter for the
 * template being written, and the common reasons Meta rejects templates, in our own words.
 */
export function GuidelinesPanel({ kind, hasMedia }: { kind: TemplateKind; hasMedia: boolean }) {
  const sections: GuidelineSection[] =
    kind === 'AUTHENTICATION'
      ? ['category', 'authentication']
      : kind === 'CAROUSEL'
        ? ['category', 'variables', 'carousel']
        : kind === 'LIMITED_TIME_OFFER'
          ? ['category', 'variables', 'offer', ...(hasMedia ? (['media'] as const) : []), 'buttons']
          : ['category', 'variables', ...(hasMedia ? (['media'] as const) : []), 'buttons'];
  return (
    <section aria-labelledby="guidelines-title" className="grid gap-2 rounded-md border p-3 text-sm" data-testid="guidelines-panel">
      <h2 id="guidelines-title" className="font-medium">
        Guidelines
      </h2>
      {sections.map((section) => {
        const entry = TEMPLATE_GUIDELINES[section];
        return (
          <details key={section} className="rounded border px-2 py-1" data-testid={`guidelines-${section}`}>
            <summary className="cursor-pointer font-medium">{entry.title}</summary>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {entry.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </details>
        );
      })}
      <details className="rounded border px-2 py-1" data-testid="guidelines-rejections">
        <summary className="cursor-pointer font-medium">Why Meta rejects templates</summary>
        <ul className="mt-1 space-y-1 text-xs">
          {REJECTION_REASONS.map((r) => (
            <li key={r.title}>
              <span className="font-medium">{r.title}:</span> <span className="text-muted-foreground">{r.points.join(' ')}</span>
            </li>
          ))}
        </ul>
      </details>
      <p className="text-xs text-muted-foreground">Checked against Meta&apos;s pages on {TEMPLATE_GUIDELINES.category.checkedAt}.</p>
    </section>
  );
}
