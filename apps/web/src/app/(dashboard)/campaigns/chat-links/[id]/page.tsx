'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { flowKeys, type FlowSummary } from '@/lib/flows';
import { formatDateTime, formatNumber } from '@/lib/format';
import { integrationsKeys, type ChatLink, type ChatLinkContact, type ChatLinkPatch, type ChatLinkResults } from '@/lib/integrations';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Tag } from '@/lib/types';

const PAGE_SIZE = 50;
const MESSAGE_MAX = 500;

/** One chat link (feature 006 US7, T076): the link and QR code, settings, results and contacts. */
export default function ChatLinkPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <ChatLinkView />
    </RequirePermission>
  );
}

function ChatLinkView() {
  const { id } = useParams<{ id: string }>();
  const link = useQuery({ queryKey: integrationsKeys.chatLink(id), queryFn: () => api<ChatLink>(`/chat-links/${id}`) });
  if (link.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (link.error || !link.data) return <p className="text-sm text-destructive">{errorMessage(link.error)}</p>;
  const l = link.data;
  return (
    <div className="grid gap-6">
      <div>
        <Link href="/campaigns/chat-links" className="text-sm text-muted-foreground hover:underline">
          ← Chat links
        </Link>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {l.name}
          {l.status === 'ACTIVE' ? <Badge variant="success">On</Badge> : <Badge variant="outline">Off</Badge>}
        </h2>
        <p className="text-sm text-muted-foreground">On {l.numberLabel}</p>
      </div>
      <LinkCard link={l} />
      <Can permission="campaigns.manage">
        <SettingsCard key={JSON.stringify([l.name, l.message, l.flowId, l.tagId, l.status])} link={l} />
      </Can>
      <ResultsCard id={l.id} />
      <ContactsCard id={l.id} />
    </div>
  );
}

function LinkCard({ link }: { link: ChatLink }) {
  const qr = (format: 'svg' | 'png', size: number) => `/api/chat-links/${link.id}/qr?format=${format}&size=${size}`;
  const prefilled = new URL(link.whatsappUrl).searchParams.get('text') ?? '';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Link and QR code</CardTitle>
        <CardDescription>Every scan goes through the short link, so openings are counted. Previews in chats and robots are not.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        {/* A plain img: the QR image is an authenticated response from our own API. */}
        <img src={qr('svg', 512)} alt={`QR code for ${link.name}`} data-testid="chat-link-qr" className="size-48 rounded-md border bg-white p-2" />
        <div className="grid content-start gap-3">
          <div className="grid gap-1">
            <Label htmlFor="cl-short">Short link</Label>
            <div className="flex flex-wrap gap-2">
              <Input id="cl-short" readOnly value={link.shortUrl} className="max-w-md font-mono text-sm" />
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(link.shortUrl)
                    .then(() => toast.success('Link copied'))
                    .catch(() => toast.error('Copy failed; select the link and copy it'))
                }
              >
                Copy
              </Button>
            </div>
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">Message the customer sends: </span>
            <span data-testid="chat-link-prefilled">{prefilled}</span>
          </div>
          <div className="flex flex-wrap gap-3 text-sm font-medium">
            <a href={qr('png', 1024)} download={`chat-link-${link.id}.png`} className="underline-offset-4 hover:underline">
              Download PNG
            </a>
            <a href={qr('svg', 1024)} download={`chat-link-${link.id}.svg`} className="underline-offset-4 hover:underline">
              Download SVG
            </a>
            <Link href={`/campaigns/chat-links/${link.id}/poster`} target="_blank" className="underline-offset-4 hover:underline">
              Open the poster
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SettingsCard({ link }: { link: ChatLink }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState(link.name);
  const [message, setMessage] = useState(link.message);
  const [flowId, setFlowId] = useState(link.flowId ?? '');
  const [tagId, setTagId] = useState(link.tagId ?? '');
  const flows = useQuery({ queryKey: flowKeys.list, queryFn: () => api<FlowSummary[]>('/flows') });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const runnable = (flows.data ?? []).filter((f) => (f.status === 'PUBLISHED' && (f.allNumbers || f.numberIds.includes(link.numberId))) || f.id === link.flowId);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: integrationsKeys.chatLink(link.id) }), queryClient.invalidateQueries({ queryKey: integrationsKeys.chatLinks })]);
  const patch = useMutation({
    mutationFn: (input: ChatLinkPatch) => api<ChatLink>(`/chat-links/${link.id}`, { method: 'PATCH', json: input }),
    onSuccess: () => {
      toast.success('Saved');
      return refresh();
    },
    onError: toastError,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
        <CardDescription>The number, the short link and the reference stay the same, so printed codes keep working.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="cl-edit-name">Name</Label>
          <Input id="cl-edit-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="max-w-md" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cl-edit-message">Pre-filled message</Label>
          <textarea
            id="cl-edit-message"
            value={message}
            maxLength={MESSAGE_MAX}
            className="min-h-[80px] max-w-2xl rounded-md border bg-background px-3 py-2 text-sm"
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="cl-edit-flow">Flow to start</Label>
            <NativeSelect id="cl-edit-flow" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
              <option value="">No flow</option>
              {runnable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cl-edit-tag">Tag for the contact</Label>
            <NativeSelect id="cl-edit-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">No tag</option>
              {(tags.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={patch.isPending || !name.trim() || !message.trim()}
            onClick={() => patch.mutate({ name: name.trim(), message: message.trim(), flowId: flowId || null, tagId: tagId || null })}
          >
            Save
          </Button>
          {link.status === 'ACTIVE' ? (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline">
                  Turn off
                </Button>
              }
              title="Turn off this chat link?"
              description="People who scan the code or open the link see a short page saying it is no longer in use. You can turn it on again."
              confirmLabel="Turn off"
              onConfirm={() => patch.mutateAsync({ status: 'OFF' })}
            />
          ) : (
            <Button size="sm" variant="outline" disabled={patch.isPending} onClick={() => patch.mutate({ status: 'ACTIVE' })}>
              Turn on
            </Button>
          )}
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost">
                Delete
              </Button>
            }
            title="Delete this chat link?"
            description="The link and its QR code stop working for good. Its openings and chats stay in reports."
            confirmLabel="Delete"
            confirmVariant="destructive"
            onConfirm={async () => {
              await api(`/chat-links/${link.id}`, { method: 'DELETE' }).catch((e: unknown) => {
                toastError(e);
                throw e;
              });
              await queryClient.invalidateQueries({ queryKey: integrationsKeys.chatLinks });
              router.push('/campaigns/chat-links');
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ResultsCard({ id }: { id: string }) {
  const results = useQuery({ queryKey: integrationsKeys.chatLinkResults(id), queryFn: () => api<ChatLinkResults>(`/chat-links/${id}/results`) });
  const r = results.data;
  const tiles: Array<[keyof ChatLinkResults['totals'], string]> = [
    ['opens', 'Opens'],
    ['chatsStarted', 'Chats started'],
    ['newContacts', 'New contacts'],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Results</CardTitle>
        <CardDescription>{r ? `${r.from} to ${r.to}` : 'Last 30 days'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {results.error ? <p className="text-sm text-destructive">{errorMessage(results.error)}</p> : null}
        {r ? (
          <>
            <div className="grid grid-cols-3 gap-3 sm:max-w-xl">
              {tiles.map(([key, label]) => (
                <div key={key} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div data-testid={`chat-link-${key}`} className="text-xl font-semibold tabular-nums">
                    {formatNumber(r.totals[key])}
                  </div>
                </div>
              ))}
            </div>
            {r.days.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    {tiles.map(([key, label]) => (
                      <TableHead key={key} className="text-right">
                        {label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.days.map((d) => (
                    <TableRow key={d.date}>
                      <TableCell>{d.date}</TableCell>
                      {tiles.map(([key]) => (
                        <TableCell key={key} className="text-right tabular-nums">
                          {formatNumber(d[key])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No openings or chats yet.</p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ContactsCard({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [tag, setTag] = useState('');
  const contacts = useQuery({
    queryKey: integrationsKeys.chatLinkContacts(id, page),
    queryFn: () => api<{ items: ChatLinkContact[]; total: number }>(`/chat-links/${id}/contacts?page=${page}&pageSize=${PAGE_SIZE}`),
  });
  const tagAll = useMutation({
    mutationFn: () => api<{ tagged: number }>(`/chat-links/${id}/contacts/tag`, { method: 'POST', json: { tag: tag.trim() } }),
    onSuccess: (r) => {
      toast.success(`Tag added to ${formatNumber(r.tagged)} contacts`);
      setTag('');
      return queryClient.invalidateQueries({ queryKey: queryKeys.tags });
    },
    onError: toastError,
  });
  const total = contacts.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">Contacts who started chats</CardTitle>
          <CardDescription>{formatNumber(total)} contacts. Tag them to use them as a campaign audience.</CardDescription>
        </div>
        <Can permission="data.export">
          <a href={`/api/chat-links/${id}/contacts/export`} className="text-sm font-medium underline-offset-4 hover:underline">
            Export CSV
          </a>
        </Can>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Can permission="campaigns.manage">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (tag.trim()) tagAll.mutate();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="cl-tag-all">Tag for all of them</Label>
              <Input id="cl-tag-all" value={tag} maxLength={50} placeholder="mall-visitors" onChange={(e) => setTag(e.target.value)} className="w-56" />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={tagAll.isPending || !tag.trim() || !total}>
              Add tag
            </Button>
          </form>
        </Can>
        {contacts.error ? <p className="text-sm text-destructive">{errorMessage(contacts.error)}</p> : null}
        {!contacts.data?.items.length ? (
          <p className="text-sm text-muted-foreground">No chats started yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.data.items.map((c) => (
                <TableRow key={c.id} data-testid="chat-link-contact">
                  <TableCell className="text-sm">{c.name ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{c.phone ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(c.startedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {pages > 1 ? (
          <div className="flex items-center gap-2 text-sm">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <span className="text-muted-foreground">
              Page {page} of {pages}
            </span>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
