'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';

// Feature 009 (US8, FR-045): a WhatsApp link and QR code for any number and message; nothing is saved.

interface LinkResult {
  url: string;
  qrPng: string;
  qrSvg: string;
  connectedNumberId: string | null;
}

export default function WhatsappLinkPage() {
  return (
    <RequirePermission permission="templates.view">
      <Generator />
    </RequirePermission>
  );
}

function Generator() {
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const make = useMutation({
    mutationFn: () => api<LinkResult>('/tools/whatsapp-link', { method: 'POST', json: { phone, ...(message.trim() ? { message: message.trim() } : {}) } }),
    onSuccess: () => setError(null),
    onError: (e) => setError(errorMessage(e)),
  });
  const result = make.data;
  function submit(event: FormEvent) {
    event.preventDefault();
    make.mutate();
  }
  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold">WhatsApp link generator</h1>
        <p className="text-sm text-muted-foreground">A wa.me link and a QR code for any number, with a message ready to send. Nothing is saved or counted; use a chat link to count scans.</p>
      </div>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="gen-phone">Phone number</Label>
          <Input id="gen-phone" value={phone} maxLength={32} placeholder="+971 50 123 4567" onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gen-message">Message (optional)</Label>
          <Input id="gen-message" value={message} maxLength={500} placeholder="Hi, I would like to know more" onChange={(e) => setMessage(e.target.value)} />
        </div>
        <Button type="submit" disabled={!phone.trim() || make.isPending}>
          {make.isPending ? 'Making…' : 'Make link'}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <Card data-testid="generated-link">
          <CardHeader>
            <CardTitle className="text-base">Your link</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <div className="grid content-start gap-2">
              <code className="break-all rounded bg-muted p-2 text-xs" data-testid="generated-url">
                {result.url}
              </code>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(result.url).catch(() => undefined);
                    toast.success('Link copied');
                  }}
                >
                  Copy link
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.qrSvg)}`} download="whatsapp-link-qr.svg">
                    Download QR (SVG)
                  </a>
                </Button>
                {result.connectedNumberId ? (
                  <Button size="sm" asChild>
                    <Link href={`/campaigns/chat-links?new=1&numberId=${result.connectedNumberId}&message=${encodeURIComponent(message.trim())}`}>Save as chat link</Link>
                  </Button>
                ) : null}
              </div>
              {result.connectedNumberId ? <p className="text-xs text-muted-foreground">This is one of your numbers: a chat link counts scans and chats, and can start a flow.</p> : null}
            </div>
            <img src={result.qrPng} alt="QR code of the link" className="h-48 w-48 rounded border" data-testid="generated-qr" />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
