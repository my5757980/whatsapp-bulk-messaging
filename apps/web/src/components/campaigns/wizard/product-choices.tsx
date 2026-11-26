'use client';

import { COMMERCE_LIMITS } from '@wbm/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Template, VariableSource } from '@/lib/types';

/** A catalog or multi-product template's product choices (feature 008 US5, R10). */
export interface ProductChoices {
  thumbnailRetailerId: string;
  sections: Array<{ title: string; retailerIds: string[] }>;
}

/** The template's catalog or product list button kind, if it has one. */
export function productButtonKind(template: Template | undefined): 'CATALOG' | 'MPM' | null {
  const buttons = (template?.components.find((c) => c.type.toUpperCase() === 'BUTTONS') as unknown as { buttons?: Array<{ type: string }> } | undefined)?.buttons ?? [];
  const kind = buttons.map((b) => b.type.toUpperCase()).find((t) => t === 'CATALOG' || t === 'MPM');
  return (kind as 'CATALOG' | 'MPM' | undefined) ?? null;
}

/** Choices kept in the campaign mapping as `$products` (static JSON, sent by the payload builder). */
export function choicesFrom(mapping: Record<string, VariableSource>): ProductChoices {
  const raw = mapping.$products?.source === 'static' ? mapping.$products.value : undefined;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<ProductChoices>) : {};
    return { thumbnailRetailerId: parsed.thumbnailRetailerId ?? '', sections: parsed.sections?.length ? parsed.sections : [{ title: '', retailerIds: [] }] };
  } catch {
    return { thumbnailRetailerId: '', sections: [{ title: '', retailerIds: [] }] };
  }
}

export function choicesMapping(kind: 'CATALOG' | 'MPM', choices: ProductChoices): VariableSource {
  const sections = kind === 'MPM' ? choices.sections.map((s) => ({ title: s.title.trim(), retailerIds: s.retailerIds })).filter((s) => s.retailerIds.length) : [];
  return { source: 'static', value: JSON.stringify({ thumbnailRetailerId: choices.thumbnailRetailerId.trim() || null, sections }) };
}

export function choicesComplete(kind: 'CATALOG' | 'MPM' | null, choices: ProductChoices): boolean {
  if (!kind) return true;
  if (!choices.thumbnailRetailerId.trim()) return false;
  if (kind === 'CATALOG') return true;
  const all = choices.sections.flatMap((s) => s.retailerIds);
  return all.length > 0 && all.length <= COMMERCE_LIMITS.listItems && (choices.sections.length === 1 || choices.sections.every((s) => s.title.trim()));
}

const ids = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The thumbnail and, for product lists, the sections of SKUs. */
export function ProductChoicesCard({ kind, value, onChange }: { kind: 'CATALOG' | 'MPM'; value: ProductChoices; onChange: (next: ProductChoices) => void }) {
  return (
    <section aria-labelledby="product-choices-title" className="grid gap-3 rounded-md border p-4" data-testid="product-choices">
      <h3 id="product-choices-title" className="text-sm font-medium">
        {kind === 'CATALOG' ? 'Catalog button' : 'Product list button'}
      </h3>
      <div className="grid gap-1.5">
        <Label htmlFor="products-thumbnail">Thumbnail product (SKU)</Label>
        <Input id="products-thumbnail" value={value.thumbnailRetailerId} onChange={(e) => onChange({ ...value, thumbnailRetailerId: e.target.value })} placeholder="shp-1234567890" />
      </div>
      {kind === 'MPM'
        ? value.sections.map((section, i) => (
            <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={`products-section-${i}-title`}>Section {i + 1} title</Label>
                <Input
                  id={`products-section-${i}-title`}
                  maxLength={COMMERCE_LIMITS.sectionTitle}
                  value={section.title}
                  onChange={(e) => onChange({ ...value, sections: value.sections.map((s, j) => (j === i ? { ...s, title: e.target.value } : s)) })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`products-section-${i}-ids`}>Section {i + 1} SKUs</Label>
                <Input
                  id={`products-section-${i}-ids`}
                  value={section.retailerIds.join(', ')}
                  placeholder="sku-1, sku-2"
                  onChange={(e) => onChange({ ...value, sections: value.sections.map((s, j) => (j === i ? { ...s, retailerIds: ids(e.target.value) } : s)) })}
                />
              </div>
            </div>
          ))
        : null}
      {kind === 'MPM' && value.sections.length < COMMERCE_LIMITS.listSections ? (
        <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => onChange({ ...value, sections: [...value.sections, { title: '', retailerIds: [] }] })}>
          Add section
        </Button>
      ) : null}
    </section>
  );
}
