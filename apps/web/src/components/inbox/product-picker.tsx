'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMMERCE_LIMITS, formatMinor } from '@wbm/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { NOT_SENDABLE_LABEL, catalogKeys, type CatalogProduct, type ProductMessageInput } from '@/lib/catalog';
import { errorMessage } from '@/lib/errors';
import type { ConversationDetail } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';

type Kind = 'product' | 'list' | 'catalog';

const price = (p: CatalogProduct) => {
  const minor = p.salePriceMinor ?? p.priceMinor;
  return minor !== null && p.currency ? formatMinor(minor, p.currency) : '';
};

/**
 * Send products in the 24-hour window (feature 008 US5, FR-023): one product, a list of up to 30
 * products in sections, or the whole catalog. Products that cannot be sent show why and cannot be picked.
 */
export function ProductPicker({ chat }: { chat: ConversationDetail }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('product');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [header, setHeader] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const products = useQuery({
    queryKey: catalogKeys.products(search, 1),
    queryFn: () => api<{ items: CatalogProduct[]; total: number }>(`/catalog/products?pageSize=50${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`),
    enabled: open,
  });

  const send = useMutation({
    mutationFn: (input: ProductMessageInput) => api<{ chatItemId: string }>(`/inbox/conversations/${chat.id}/products`, { method: 'POST', json: input }),
    onSuccess: () => {
      toast.success(kind === 'catalog' ? 'Catalog sent' : kind === 'list' ? 'Product list sent' : 'Product sent');
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxItems(chat.id) });
      setOpen(false);
      setPicked([]);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const toggle = (id: string) => {
    if (kind === 'product' || kind === 'catalog') return setPicked(picked[0] === id ? [] : [id]);
    setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : picked.length < COMMERCE_LIMITS.listItems ? [...picked, id] : picked);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === 'product' && picked[0]) send.mutate({ kind: 'product', retailerId: picked[0], ...(body.trim() ? { body: body.trim() } : {}) });
    else if (kind === 'list') send.mutate({ kind: 'list', header: header.trim(), body: body.trim(), sections: [{ retailerIds: picked }] });
    else if (kind === 'catalog') send.mutate({ kind: 'catalog', body: body.trim(), ...(picked[0] ? { thumbnailRetailerId: picked[0] } : {}) });
  };
  const ready = kind === 'product' ? picked.length === 1 : kind === 'list' ? picked.length > 0 && header.trim() && body.trim() : body.trim();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Send products
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>Send products</DialogTitle>
            <DialogDescription>From the Meta catalog, inside the 24-hour window.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="product-kind">What to send</Label>
            <NativeSelect id="product-kind" value={kind} onChange={(e) => (setKind(e.target.value as Kind), setPicked([]))}>
              <option value="product">One product</option>
              <option value="list">A product list</option>
              <option value="catalog">The whole catalog</option>
            </NativeSelect>
          </div>
          {kind === 'list' ? (
            <div className="grid gap-1">
              <Label htmlFor="product-header">Header</Label>
              <Input id="product-header" maxLength={COMMERCE_LIMITS.header} value={header} onChange={(e) => setHeader(e.target.value)} />
            </div>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor="product-body">{kind === 'product' ? 'Text (optional)' : 'Text'}</Label>
            <Input id="product-body" maxLength={COMMERCE_LIMITS.body} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="product-search">{kind === 'catalog' ? 'Thumbnail product (optional)' : kind === 'list' ? `Products (up to ${COMMERCE_LIMITS.listItems})` : 'Product'}</Label>
            <Input id="product-search" placeholder="Search by name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <ul className="grid max-h-64 gap-1 overflow-y-auto" aria-label="Products" data-testid="product-results">
            {(products.data?.items ?? []).map((p) => (
              <li key={p.retailerId}>
                <label className={`flex items-center gap-2 rounded-md border p-2 text-sm ${p.sendable ? '' : 'opacity-60'}`}>
                  <input type={kind === 'list' ? 'checkbox' : 'radio'} name="product" disabled={!p.sendable} checked={picked.includes(p.retailerId)} onChange={() => toggle(p.retailerId)} />
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="size-8 rounded object-cover" /> : null}
                  <span className="grid flex-1">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.retailerId} {price(p) ? `· ${price(p)}` : ''}
                    </span>
                  </span>
                  {!p.sendable && p.notSendableReason ? <span className="text-xs text-destructive">{NOT_SENDABLE_LABEL[p.notSendableReason]}</span> : null}
                </label>
              </li>
            ))}
            {products.isSuccess && !products.data.items.length ? <li className="text-sm text-muted-foreground">No products found.</li> : null}
          </ul>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!ready || send.isPending}>
              {send.isPending ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
