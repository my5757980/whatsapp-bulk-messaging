'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { catalogKeys, type CatalogProduct } from '@/lib/catalog';
import { formsKeys, type FormSummary } from '@/lib/forms';
import { TEXTAREA_CLASS, cleanAnswerName } from './form-bits';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

// Commerce steps of the flow builder (feature 008 US8, R10 – R12): send products or the catalog and wait
// for a cart, or send a form and wait for its answer; each has a timeout branch.

type ProductStep = StepOf<'product'>;
type CatalogStep = StepOf<'catalog'>;
type FormStep = StepOf<'form'>;
type Waiting = ProductStep | CatalogStep | FormStep;

const ids = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function TimeoutAndBranches<T extends Waiting>({ step, graph, onPatch, waitsFor }: { step: T; graph: FlowGraph; onPatch: StepPatch<T>; waitsFor: string }) {
  return (
    <>
      <div className="grid gap-1">
        <Label htmlFor={`${step.id}-timeout`}>Wait for {waitsFor} (minutes)</Label>
        <Input
          id={`${step.id}-timeout`}
          type="number"
          min={FLOW_LIMITS.timeoutMinutesMin}
          max={FLOW_LIMITS.timeoutMinutesMax}
          value={step.timeoutMinutes}
          onChange={(e) => {
            const minutes = Number(e.target.value);
            if (Number.isInteger(minutes) && minutes >= FLOW_LIMITS.timeoutMinutesMin && minutes <= FLOW_LIMITS.timeoutMinutesMax) onPatch({ timeoutMinutes: minutes } as Partial<T>, 'timeout');
          }}
        />
      </div>
      <GoesToSelect id={`${step.id}-next`} label={`When ${waitsFor} arrives, go to`} graph={graph} fromId={step.id} value={step.next} required onChange={(next) => onPatch({ next } as Partial<T>)} />
      <GoesToSelect id={`${step.id}-timeout-branch`} label="When nothing arrives in time, go to" graph={graph} fromId={step.id} value={step.onTimeout} onChange={(onTimeout) => onPatch({ onTimeout } as Partial<T>)} />
    </>
  );
}

/** Finds sendable catalog products by name or SKU and adds one to a section. */
function ProductFinder({ id, onAdd }: { id: string; onAdd: (retailerId: string) => void }) {
  const [search, setSearch] = useState('');
  const term = search.trim();
  const products = useQuery({
    queryKey: catalogKeys.products(term, 1, true),
    queryFn: () => api<{ items: CatalogProduct[]; total: number }>(`/catalog/products?pageSize=8&sendable=true&search=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
  });
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>Find a product</Label>
      <Input id={id} placeholder="Name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
      {products.data?.items.length ? (
        <ul className="grid gap-1 text-sm">
          {products.data.items.map((p) => (
            <li key={p.retailerId} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {p.name} <span className="text-muted-foreground">({p.retailerId})</span>
              </span>
              <button type="button" className="text-primary hover:underline" onClick={() => onAdd(p.retailerId)}>
                Add
              </button>
            </li>
          ))}
        </ul>
      ) : term.length >= 2 && products.isSuccess ? (
        <p className="text-xs text-muted-foreground">No sendable products match.</p>
      ) : null}
    </div>
  );
}

/** Send one product or a product list (sections of SKUs), then wait for the cart ({answer:cart_total}). */
export function ProductStepForm({ step, graph, onPatch }: { step: ProductStep; graph: FlowGraph; onPatch: StepPatch<ProductStep> }) {
  const setSection = (i: number, patch: Partial<ProductStep['sections'][number]>) => onPatch({ sections: step.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }, 'sections');
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="product-header">Header (for a list)</Label>
        <Input id="product-header" maxLength={60} value={step.header} onChange={(e) => onPatch({ header: e.target.value }, 'header')} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="product-body">Text</Label>
        <textarea id="product-body" className={TEXTAREA_CLASS} maxLength={1024} value={step.body} onChange={(e) => onPatch({ body: e.target.value }, 'body')} />
      </div>
      {step.sections.map((section, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-2">
          <div className="grid gap-1">
            <Label htmlFor={`product-section-${i}-title`}>Section {i + 1} title</Label>
            <Input id={`product-section-${i}-title`} maxLength={24} value={section.title} onChange={(e) => setSection(i, { title: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`product-section-${i}-ids`}>Section {i + 1} SKUs</Label>
            <Input id={`product-section-${i}-ids`} placeholder="shp-101, shp-102" value={section.retailerIds.join(', ')} onChange={(e) => setSection(i, { retailerIds: ids(e.target.value) })} />
          </div>
          <ProductFinder
            id={`product-section-${i}-find`}
            onAdd={(retailerId) => {
              if (!section.retailerIds.includes(retailerId)) setSection(i, { retailerIds: [...section.retailerIds, retailerId] });
            }}
          />
        </div>
      ))}
      {step.sections.length < 10 ? (
        <button type="button" className="justify-self-start text-sm text-primary hover:underline" onClick={() => onPatch({ sections: [...step.sections, { title: '', retailerIds: [] }] }, 'sections')}>
          Add section
        </button>
      ) : null}
      <p className="text-xs text-muted-foreground">One SKU sends a single product; more send a list of up to 30. The cart is saved as {'{answer:cart_total}'}.</p>
      <TimeoutAndBranches step={step} graph={graph} onPatch={onPatch} waitsFor="a cart" />
    </div>
  );
}

/** Send the whole catalog, then wait for a cart. */
export function CatalogStepForm({ step, graph, onPatch }: { step: CatalogStep; graph: FlowGraph; onPatch: StepPatch<CatalogStep> }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="catalog-body">Text</Label>
        <textarea id="catalog-body" className={TEXTAREA_CLASS} maxLength={1024} value={step.body} onChange={(e) => onPatch({ body: e.target.value }, 'body')} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="catalog-thumbnail">Thumbnail product (SKU, optional)</Label>
        <Input id="catalog-thumbnail" value={step.thumbnailRetailerId ?? ''} onChange={(e) => onPatch({ thumbnailRetailerId: e.target.value.trim() || null }, 'thumbnailRetailerId')} />
      </div>
      <TimeoutAndBranches step={step} graph={graph} onPatch={onPatch} waitsFor="a cart" />
    </div>
  );
}

/** Send a published WhatsApp Form, then wait for its answer ({answer:<prefix>_<field>}). */
export function FormStepForm({ step, graph, onPatch }: { step: FormStep; graph: FlowGraph; onPatch: StepPatch<FormStep> }) {
  const forms = useQuery({ queryKey: formsKeys.list('PUBLISHED'), queryFn: () => api<{ items: FormSummary[] }>('/forms?status=PUBLISHED') });
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="form-step-form">Form</Label>
        <NativeSelect id="form-step-form" value={step.formId ?? ''} onChange={(e) => onPatch({ formId: e.target.value || null }, 'formId')}>
          <option value="">Choose a published form…</option>
          {(forms.data?.items ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="form-step-body">Text</Label>
        <textarea id="form-step-body" className={TEXTAREA_CLASS} maxLength={1024} value={step.body} onChange={(e) => onPatch({ body: e.target.value }, 'body')} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="form-step-cta">Button</Label>
        <Input id="form-step-cta" maxLength={30} value={step.cta} onChange={(e) => onPatch({ cta: e.target.value }, 'cta')} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="form-step-prefix">Save answers as</Label>
        <Input
          id="form-step-prefix"
          value={step.answerPrefix}
          onChange={(e) => {
            const name = cleanAnswerName(e.target.value);
            if (name) onPatch({ answerPrefix: name }, 'answerPrefix');
          }}
        />
        <p className="text-xs text-muted-foreground">
          Each field is then {'{answer:'}
          {step.answerPrefix}_<i>field</i>
          {'}'}.
        </p>
      </div>
      <TimeoutAndBranches step={step} graph={graph} onPatch={onPatch} waitsFor="the answer" />
    </div>
  );
}
