'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { flowKeys, type FlowSummary } from '@/lib/flows';
import { formatDateTime, formatNumber } from '@/lib/format';
import { integrationsKeys, type ChatLink, type ChatLinkInput } from '@/lib/integrations';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Tag, WhatsAppNumber } from '@/lib/types';

const MESSAGE_MAX = 500;

/** Campaigns > Chat links (feature 006 US7, T076): QR codes and short links that open a chat. */
export default function ChatLinksPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <ChatLinkList />
    </RequirePermission>
  );
}

function ChatLinkList() {
  const links = useQuery({ queryKey: integrationsKeys.chatLinks, queryFn: () => api<ChatLink[]>('/chat-links') });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/campaigns" className="text-sm text-muted-foreground hover:underline">
            ← Campaigns
          </Link>
          <h2 className="text-lg font-semibold">Chat links</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            A short link and a QR code for posters, packaging and shop counters. Scanning it opens WhatsApp with your message ready; when the customer sends it, the
            chat can start a flow and tag the contact.
          </p>
        </div>
        <Can permission="campaigns.manage">
          <NewChatLinkDialog />
        </Can>
      </div>
      <Card>
        <CardContent className="p-0">
          {links.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : links.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(links.error)}</p>
          ) : !links.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No chat links yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Opens</TableHead>
                  <TableHead className="text-right">Chats started</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.data.map((l) => (
                  <TableRow key={l.id} data-testid="chat-link-row">
                    <TableCell>
                      <Link href={`/campaigns/chat-links/${l.id}`} className="font-medium hover:underline">
                        {l.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{l.numberLabel}</TableCell>
                    <TableCell>{l.status === 'ACTIVE' ? <Badge variant="success">On</Badge> : <Badge variant="outline">Off</Badge>}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(l.opens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(l.chatsStarted)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(l.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NewChatLinkDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [numberId, setNumberId] = useState('');
  const [message, setMessage] = useState('');
  const [flowId, setFlowId] = useState('');
  const [tagId, setTagId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers'), enabled: open });
  const flows = useQuery({ queryKey: flowKeys.list, queryFn: () => api<FlowSummary[]>('/flows'), enabled: open });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags'), enabled: open });
  const connected = (numbers.data ?? []).filter((n) => n.connectionStatus === 'CONNECTED');
  const runnable = (flows.data ?? []).filter((f) => f.status === 'PUBLISHED' && numberId && (f.allNumbers || f.numberIds.includes(numberId)));

  const create = useMutation({
    mutationFn: () => {
      const input: ChatLinkInput = { name: name.trim(), numberId, message: message.trim(), flowId: flowId || null, tagId: tagId || null };
      return api<ChatLink>('/chat-links', { method: 'POST', json: input });
    },
    onSuccess: (l) => router.push(`/campaigns/chat-links/${l.id}`),
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim() || !numberId || !message.trim()) {
      setError('Enter a name and a message, and choose a number.');
      return;
    }
    create.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName('');
          setNumberId('');
          setMessage('');
          setFlowId('');
          setTagId('');
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>New chat link</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New chat link</DialogTitle>
          <DialogDescription>The short link and its reference are made once, so printed codes keep working when you edit the link later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="cl-name">Name</Label>
            <Input id="cl-name" value={name} maxLength={80} placeholder="Shop counter" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cl-number">WhatsApp number</Label>
            <NativeSelect
              id="cl-number"
              value={numberId}
              onChange={(e) => {
                setNumberId(e.target.value);
                setFlowId('');
              }}
            >
              <option value="">Choose a connected number…</option>
              {connected.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} ({n.displayPhoneNumber})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cl-message">Pre-filled message</Label>
            <textarea
              id="cl-message"
              value={message}
              maxLength={MESSAGE_MAX}
              placeholder="Hi, I saw your poster at the mall"
              className="min-h-[80px] rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(e) => setMessage(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {message.length} / {MESSAGE_MAX}. A short reference like &quot;(ref K7QX2M)&quot; is added at the end so we know which link the chat came from.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cl-flow">Flow to start (optional)</Label>
            <NativeSelect id="cl-flow" value={flowId} onChange={(e) => setFlowId(e.target.value)} disabled={!numberId}>
              <option value="">No flow</option>
              {runnable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">Published flows that run on the number.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cl-tag">Tag for the contact (optional)</Label>
            <NativeSelect id="cl-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">No tag</option>
              {(tags.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create chat link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
