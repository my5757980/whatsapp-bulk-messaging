'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { consentLabel, formatDateTime } from '@/lib/format';
import { Can, usePermissions } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, Contact, ConsentStatusValue, Paged, Tag } from '@/lib/types';
import { LEAD_SOURCE_KINDS, LEAD_SOURCE_LABELS, leadSourceText, type LeadSourceKind } from '@wbm/shared';
import { BulkTagsDialog } from '@/components/contacts/bulk-tags-dialog';
import { contacts010Keys, type BulkSelection, type Segment } from '@/lib/contacts-010';

const PAGE_SIZE = 50;

/** Contacts list with search, filters and bulk actions (T127). Phones arrive masked for agents. */
export default function ContactsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <ContactsList />
    </Suspense>
  );
}

function ContactsList() {
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [tag, setTag] = useState('');
  const [consent, setConsent] = useState<'' | ConsentStatusValue>('');
  // Feature 010: a saved segment and the lead source (FR-007, FR-012).
  const [segmentId, setSegmentId] = useState(params.get('segmentId') ?? '');
  const [leadSource, setLeadSource] = useState<'' | LeadSourceKind>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filters = { q, tag, consent, segmentId, leadSource, page };
  const contacts = useQuery({
    queryKey: queryKeys.contacts(filters),
    queryFn: () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (q) qs.set('q', q);
      if (tag) qs.set('tag', tag);
      if (consent) qs.set('consent', consent);
      if (segmentId) qs.set('segmentId', segmentId);
      if (leadSource) qs.set('leadSource', leadSource);
      return api<Paged<Contact>>(`/contacts?${qs}`);
    },
  });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const segments = useQuery({ queryKey: contacts010Keys.segments, queryFn: () => api<{ items: Segment[] }>('/segments') });
  // The same selection the list shows, for the export and for "all matching" bulk actions.
  const matching: BulkSelection = segmentId ? { segmentId } : { filter: { ...(q ? { q } : {}), ...(tag ? { tag: [tag] } : {}), ...(consent ? { consent } : {}), ...(leadSource ? { leadSource } : {}) } };
  const exportQuery = new URLSearchParams({ ...(segmentId ? { segmentId } : {}), ...(q ? { q } : {}), ...(tag ? { tag } : {}), ...(consent ? { consent } : {}), ...(leadSource ? { leadSource } : {}) });
  const pages = Math.max(1, Math.ceil((contacts.data?.page.total ?? 0) / PAGE_SIZE));
  const items = contacts.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((c) => selected.has(c.id));
  const refresh = () => {
    setSelected(new Set());
    return Promise.all([queryClient.invalidateQueries({ queryKey: ['contacts'] }), queryClient.invalidateQueries({ queryKey: queryKeys.tags })]);
  };

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-sm text-muted-foreground">Everyone you can message, with tags, attributes and consent status.</p>
        </div>
        <Can permission="contacts.manage">
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/contacts/segments">Segments</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/contacts/import">Import</Link>
            </Button>
            <AddContactDialog onCreated={refresh} />
          </div>
        </Can>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(search.trim());
          setPage(1);
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="contact-search">Search</Label>
          <Input id="contact-search" className="w-64" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or phone" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="contact-tag">Tag</Label>
          <NativeSelect
            id="contact-tag"
            className="w-44"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All tags</option>
            {(tags.data ?? []).map((t) => (
              <option key={t.id} value={t.name}>
                {t.name} ({t.contactCount})
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="contact-consent">Consent</Label>
          <NativeSelect
            id="contact-consent"
            className="w-40"
            value={consent}
            onChange={(e) => {
              setConsent(e.target.value as '' | ConsentStatusValue);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="OPTED_IN">Opted in</option>
            <option value="UNKNOWN">Unknown</option>
            <option value="OPTED_OUT">Opted out</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="contact-lead-source">Lead source</Label>
          <NativeSelect
            id="contact-lead-source"
            className="w-44"
            value={leadSource}
            onChange={(e) => {
              setLeadSource(e.target.value as '' | LeadSourceKind);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            {LEAD_SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {LEAD_SOURCE_LABELS[k]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="contact-segment">Segment</Label>
          <NativeSelect
            id="contact-segment"
            className="w-48"
            value={segmentId}
            onChange={(e) => {
              setSegmentId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">No segment</option>
            {(segments.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Can permission="contacts.manage">
          <BulkTagsDialog selection={matching} count={contacts.data?.page.total ?? 0} tags={tags.data ?? []} onDone={() => void refresh()} />
          {selected.size ? <BulkTagsDialog selection={{ contactIds: [...selected] }} count={selected.size} tags={tags.data ?? []} onDone={() => void refresh()} /> : null}
        </Can>
        <Can permission="data.export">
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/contacts/export.csv?${exportQuery}`} download>
              Export CSV
            </a>
          </Button>
        </Can>
      </div>

      {selected.size && can('contacts.manage') ? <BulkBar ids={[...selected]} tags={tags.data ?? []} onDone={refresh} /> : null}

      <Card>
        <CardContent className="p-0">
          {contacts.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : contacts.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(contacts.error)}</p>
          ) : !items.length ? (
            <p className="p-6 text-sm text-muted-foreground">No contacts match.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((c) => c.id)))}
                    />
                  </TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Consent</TableHead>
                  <TableHead>Lead source</TableHead>
                  <TableHead>Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id} data-testid="contact-row">
                    <TableCell>
                      <input type="checkbox" aria-label={`Select ${c.name ?? c.phone}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    </TableCell>
                    <TableCell>
                      <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">
                        {c.name ?? 'Unnamed contact'}
                      </Link>
                      <div className="text-xs text-muted-foreground">{c.phone}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {c.tags.map((t) => (
                          <Badge key={t} variant="secondary">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={consentLabel[c.consentStatus].variant}>{consentLabel[c.consentStatus].label}</Badge>
                    </TableCell>
                    <TableCell className="text-xs" data-testid="lead-source">
                      {c.leadSource ? leadSourceText(c.leadSource as LeadSourceKind, c.leadSourceLabel) : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{contacts.data ? `${contacts.data.page.total} contacts` : ''}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
            Previous
          </Button>
          <span>
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= pages}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function BulkBar({ ids, tags, onDone }: { ids: string[]; tags: Tag[]; onDone: () => Promise<unknown> }) {
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const [tag, setTag] = useState('');
  const [attributeKey, setAttributeKey] = useState('');
  const [attributeValue, setAttributeValue] = useState('');
  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ updated: number }>('/contacts/bulk', { method: 'POST', json: { contactIds: ids, ...body } }),
    onSuccess: async (r) => {
      toast.success(`${r.updated} contacts updated`);
      await onDone();
    },
    onError: toastError,
  });

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/40 p-3 text-sm" data-testid="bulk-bar">
      <span className="font-medium">{ids.length} selected</span>
      <div className="flex items-end gap-2">
        <Input aria-label="Tag name" list="known-tags" className="w-40" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="tag" />
        <datalist id="known-tags">
          {tags.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
        <Button size="sm" disabled={!tag.trim() || bulk.isPending} onClick={() => bulk.mutate({ action: 'ADD_TAG', tag: tag.trim() })}>
          Add tag
        </Button>
        <Button size="sm" variant="outline" disabled={!tag.trim() || bulk.isPending} onClick={() => bulk.mutate({ action: 'REMOVE_TAG', tag: tag.trim() })}>
          Remove tag
        </Button>
      </div>
      <div className="flex items-end gap-2">
        <NativeSelect aria-label="Attribute" className="w-40" value={attributeKey} onChange={(e) => setAttributeKey(e.target.value)}>
          <option value="">Attribute…</option>
          {(attributes.data ?? []).map((a) => (
            <option key={a.id} value={a.key}>
              {a.label} ({a.type.toLowerCase()})
            </option>
          ))}
        </NativeSelect>
        <Input aria-label="Attribute value" className="w-36" value={attributeValue} onChange={(e) => setAttributeValue(e.target.value)} placeholder="value (empty clears)" />
        <Button
          size="sm"
          variant="secondary"
          disabled={!attributeKey || bulk.isPending}
          onClick={() => bulk.mutate({ action: 'SET_ATTRIBUTE', attributeKey, attributeValue: attributeValue.trim() === '' ? null : attributeValue.trim() })}
        >
          Set attribute
        </Button>
      </div>
    </div>
  );
}

function AddContactDialog({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<ConsentStatusValue>('UNKNOWN');
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Contact>('/contacts', { method: 'POST', json: body }),
    onSuccess: async () => {
      toast.success('Contact added');
      setOpen(false);
      await onCreated();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const note = String(form.get('note') ?? '').trim();
    create.mutate({
      phone: String(form.get('phone') ?? '').trim(),
      ...(name ? { name } : {}),
      ...(consent !== 'UNKNOWN' ? { consentStatus: consent } : {}),
      ...(note ? { consentSourceNote: note } : {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add contact</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a contact</DialogTitle>
          <DialogDescription>Numbers without a country code use the default country from Settings.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="new-phone">Phone</Label>
            <Input id="new-phone" name="phone" required placeholder="+971 50 123 4567" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-name">Name</Label>
            <Input id="new-name" name="name" maxLength={120} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-consent">Consent</Label>
            <NativeSelect id="new-consent" value={consent} onChange={(e) => setConsent(e.target.value as ConsentStatusValue)}>
              <option value="UNKNOWN">Unknown</option>
              <option value="OPTED_IN">Opted in</option>
              <option value="OPTED_OUT">Opted out</option>
            </NativeSelect>
          </div>
          {consent === 'OPTED_IN' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="new-note">Where did they opt in?</Label>
              <Input id="new-note" name="note" required minLength={3} maxLength={500} />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Add contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
