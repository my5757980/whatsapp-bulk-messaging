'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { integrationsKeys, type ChatLink } from '@/lib/integrations';

// Printing shows the poster only, whatever the dashboard layout around it.
const PRINT_CSS = `@media print {
  @page { size: A4 portrait; margin: 12mm; }
  body * { visibility: hidden !important; }
  .chat-poster, .chat-poster * { visibility: visible !important; }
  .chat-poster { position: absolute; inset: 0; margin: 0; border: none; box-shadow: none; }
}`;

/** A printable poster of our own design for a chat link (feature 006 US7, FR-046). */
export default function ChatLinkPosterPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <Poster />
    </RequirePermission>
  );
}

function Poster() {
  const { id } = useParams<{ id: string }>();
  const link = useQuery({ queryKey: integrationsKeys.chatLink(id), queryFn: () => api<ChatLink>(`/chat-links/${id}`) });
  const [headline, setHeadline] = useState('Chat with us on WhatsApp');
  const [note, setNote] = useState('Scan the code with your phone camera');
  if (link.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (link.error || !link.data) return <p className="text-sm text-destructive">{errorMessage(link.error)}</p>;
  const l = link.data;

  return (
    <div className="grid gap-6">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="grid gap-1.5">
          <Label htmlFor="poster-headline">Headline</Label>
          <Input id="poster-headline" value={headline} maxLength={60} onChange={(e) => setHeadline(e.target.value)} className="w-72" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="poster-note">Line under the code</Label>
          <Input id="poster-note" value={note} maxLength={80} onChange={(e) => setNote(e.target.value)} className="w-80" />
        </div>
        <Button onClick={() => window.print()}>Print</Button>
      </div>
      <section
        data-testid="chat-link-poster"
        className="chat-poster mx-auto flex aspect-[210/297] w-full max-w-[560px] flex-col items-center justify-between rounded-lg border bg-white p-10 text-center text-neutral-900 shadow-sm"
      >
        <h1 className="text-4xl font-bold leading-tight">{headline}</h1>
        <div className="grid justify-items-center gap-4">
          {/* A plain img: the QR image is an authenticated response from our own API. */}
          <img src={`/api/chat-links/${l.id}/qr?format=svg&size=1024`} alt={`QR code for ${l.name}`} className="size-72" />
          <p className="text-lg">{note}</p>
        </div>
        <div className="grid gap-1">
          <p className="text-sm text-neutral-600">or open</p>
          <p className="font-mono text-base">{l.shortUrl.replace(/^https?:\/\//, '')}</p>
        </div>
      </section>
    </div>
  );
}
