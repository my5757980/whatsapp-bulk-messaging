'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { growthKeys, type TrackedLinkConfig } from '@/lib/growth';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { WhatsAppNumber } from '@/lib/types';
import type { ChatWidget, ChatWidgetInput, ChatWidgetStats, WidgetRule } from '../widget-types';

// Feature 009 (US8, FR-039 - FR-043): the website button designer with a live preview, page rules in
// order, the snippet, a setup guide and the counts.

const EMPTY: ChatWidgetInput = {
  name: '',
  numberId: '',
  look: { colour: '#25D366', buttonText: 'Chat with us', corner: 'BOTTOM_RIGHT', offsetX: 20, offsetY: 20, radius: 24 },
  brandName: '',
  brandImageAssetId: null,
  greeting: 'Hi! How can we help you today?',
  message: 'Hello, I have a question',
  rules: [],
};

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');

/** The preview page drawn at a real screen size and scaled down to the space it has (FR-040). */
function ScaledFrame({ srcDoc, width, height }: { srcDoc: string; width: number; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / width));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  return (
    <div ref={box} className="mx-auto w-full overflow-hidden rounded border" style={{ maxWidth: width, height: Math.round(height * scale) }}>
      <iframe title="Button preview" sandbox="allow-scripts" srcDoc={srcDoc} data-testid="widget-preview" style={{ width, height, border: 0, transform: `scale(${scale})`, transformOrigin: 'top left' }} />
    </div>
  );
}

export default function WebsiteButtonPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <Designer />
    </RequirePermission>
  );
}

function Designer() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const router = useRouter();
  const queryClient = useQueryClient();
  const widget = useQuery({ queryKey: ['chat-widget', id], queryFn: () => api<ChatWidget>(`/chat-widgets/${id}`), enabled: !isNew });
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const linkConfig = useQuery({ queryKey: growthKeys.linkConfig, queryFn: () => api<TrackedLinkConfig>('/tracked-links/config'), staleTime: 5 * 60_000 });
  const stats = useQuery({ queryKey: ['chat-widget', id, 'stats'], queryFn: () => api<ChatWidgetStats>(`/chat-widgets/${id}/stats`), enabled: !isNew });
  const [form, setForm] = useState<ChatWidgetInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<'desktop' | 'phone'>('desktop');

  useEffect(() => {
    if (widget.data) {
      const { name, numberId, look, brandName, brandImageAssetId, greeting, message, rules } = widget.data;
      setForm({ name, numberId, look, brandName, brandImageAssetId, greeting, message, rules });
    }
  }, [widget.data]);
  const connected = (numbers.data ?? []).filter((n) => n.connectionStatus === 'CONNECTED');
  const numberId = form.numberId || connected[0]?.id || '';
  const set = (patch: Partial<ChatWidgetInput>) => setForm((f) => ({ ...f, ...patch }));
  const setRule = (i: number, patch: Partial<WidgetRule>) => set({ rules: form.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const move = (i: number, by: -1 | 1) => {
    const rules = [...form.rules];
    const [rule] = rules.splice(i, 1);
    rules.splice(i + by, 0, rule!);
    set({ rules });
  };

  const save = useMutation({
    mutationFn: () => {
      const body: ChatWidgetInput = { ...form, numberId, rules: form.rules.map((r) => ({ ...r, greeting: r.greeting || null, message: r.hide ? null : r.message || null })) };
      return isNew ? api<ChatWidget>('/chat-widgets', { method: 'POST', json: body }) : api<ChatWidget>(`/chat-widgets/${id}`, { method: 'PUT', json: body });
    },
    onSuccess: (saved) => {
      setError(null);
      toast.success('Website button saved');
      void queryClient.invalidateQueries({ queryKey: ['chat-widgets'] });
      if (isNew) router.push(`/website-button/${saved.id}`);
      else void queryClient.invalidateQueries({ queryKey: ['chat-widget', id] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const status = useMutation({
    mutationFn: (next: 'pause' | 'resume') => api<ChatWidget>(`/chat-widgets/${id}/${next}`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat-widget', id] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/chat-widgets/${id}`, { method: 'DELETE' }),
    onSuccess: () => router.push('/website-button'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const data = new FormData();
      data.set('file', file);
      data.set('purpose', 'TEMPLATE_SAMPLE');
      return api<{ id: string }>('/media', { method: 'POST', body: data });
    },
    onSuccess: (m) => set({ brandImageAssetId: m.id }),
    onError: (e) => setError(errorMessage(e)),
  });

  const base = linkConfig.data?.baseUrl?.replace(/\/+$/, '') ?? null;
  const preview = useMemo(() => {
    if (!base) return null;
    const config = { hidden: false, version: 'preview', look: form.look, brandName: form.brandName || 'Your business', brandImageUrl: null, greeting: form.greeting, startUrl: 'about:blank', rules: [] };
    return `<!doctype html><html><body style="margin:0;min-height:100vh;background:#f4f4f5;font-family:sans-serif"><p style="padding:16px;color:#71717a">Your website</p><script src="${base}/w/widget.js" data-preview='${attr(JSON.stringify(config))}'></script></body></html>`;
  }, [base, form.look, form.brandName, form.greeting]);

  if (!isNew && widget.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!isNew && widget.error) return <p className="text-sm text-destructive">{errorMessage(widget.error)}</p>;
  const w = widget.data;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/website-button" className="text-sm text-muted-foreground hover:underline">
            ← Website chat button
          </Link>
          <h1 className="text-2xl font-semibold">{isNew ? 'New website button' : w?.name}</h1>
        </div>
        {w ? (
          <Can permission="campaigns.manage">
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => status.mutate(w.status === 'ACTIVE' ? 'pause' : 'resume')} disabled={status.isPending}>
                {w.status === 'ACTIVE' ? 'Pause' : 'Show again'}
              </Button>
              <Button variant="outline" onClick={() => window.confirm('Delete this button? The snippet will show nothing.') && remove.mutate()}>
                Delete
              </Button>
            </div>
          </Can>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_26rem]">
        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Button</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="wb-name">Name</Label>
                <Input id="wb-name" value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Main website" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wb-number">Number</Label>
                <NativeSelect id="wb-number" value={numberId} onChange={(e) => set({ numberId: e.target.value })}>
                  {connected.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label} ({n.displayPhoneNumber})
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wb-colour">Button colour</Label>
                <Input id="wb-colour" type="color" value={form.look.colour} onChange={(e) => set({ look: { ...form.look, colour: e.target.value } })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wb-text">Button text</Label>
                <Input id="wb-text" value={form.look.buttonText} maxLength={30} onChange={(e) => set({ look: { ...form.look, buttonText: e.target.value } })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wb-corner">Corner</Label>
                <NativeSelect id="wb-corner" value={form.look.corner} onChange={(e) => set({ look: { ...form.look, corner: e.target.value as 'BOTTOM_LEFT' | 'BOTTOM_RIGHT' } })}>
                  <option value="BOTTOM_RIGHT">Bottom right</option>
                  <option value="BOTTOM_LEFT">Bottom left</option>
                </NativeSelect>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(['offsetX', 'offsetY', 'radius'] as const).map((key) => (
                  <div key={key} className="grid gap-1.5">
                    <Label htmlFor={`wb-${key}`}>{key === 'offsetX' ? 'Side (px)' : key === 'offsetY' ? 'Bottom (px)' : 'Rounding'}</Label>
                    <Input id={`wb-${key}`} type="number" min={0} max={key === 'radius' ? 40 : 200} value={form.look[key]} onChange={(e) => set({ look: { ...form.look, [key]: Number(e.target.value) || 0 } })} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Greeting and message</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="wb-brand">Brand name</Label>
                  <Input id="wb-brand" value={form.brandName} maxLength={60} onChange={(e) => set({ brandName: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="wb-image">Brand image (optional)</Label>
                  <Input id="wb-image" type="file" accept="image/png,image/jpeg" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
                  {form.brandImageAssetId ? <p className="text-xs text-muted-foreground">Image uploaded.</p> : null}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wb-greeting">Greeting</Label>
                <Input id="wb-greeting" value={form.greeting} maxLength={300} onChange={(e) => set({ greeting: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wb-message">Default message</Label>
                <Input id="wb-message" value={form.message} maxLength={500} onChange={(e) => set({ message: e.target.value })} />
                <p className="text-xs text-muted-foreground">The message the customer sends when the chat opens.</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Page rules</CardTitle>
              <CardDescription>Tried in this order; the first that fits the page wins. Use them to hide the button or to change the greeting and message.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {form.rules.map((rule, i) => (
                <div key={rule.id ?? i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[9rem_1fr]" data-testid={`rule-${i + 1}`}>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`wb-rule-${i}-match`}>Rule {i + 1} match</Label>
                    <NativeSelect id={`wb-rule-${i}-match`} value={rule.match} onChange={(e) => setRule(i, { match: e.target.value as WidgetRule['match'] })}>
                      <option value="EXACT">Page is</option>
                      <option value="PREFIX">Page starts with</option>
                      <option value="CONTAINS">Page contains</option>
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`wb-rule-${i}-value`}>Rule {i + 1} page</Label>
                    <Input id={`wb-rule-${i}-value`} value={rule.value} maxLength={200} placeholder="/products" onChange={(e) => setRule(i, { value: e.target.value })} />
                  </div>
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <input type="checkbox" checked={rule.hide} onChange={(e) => setRule(i, { hide: e.target.checked })} aria-label={`Rule ${i + 1} hide`} />
                    Hide the button on these pages
                  </label>
                  {!rule.hide ? (
                    <>
                      <div className="grid gap-1.5">
                        <Label htmlFor={`wb-rule-${i}-greeting`}>Rule {i + 1} greeting</Label>
                        <Input id={`wb-rule-${i}-greeting`} value={rule.greeting ?? ''} maxLength={300} onChange={(e) => setRule(i, { greeting: e.target.value })} />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={`wb-rule-${i}-message`}>Rule {i + 1} message</Label>
                        <Input id={`wb-rule-${i}-message`} value={rule.message ?? ''} maxLength={500} onChange={(e) => setRule(i, { message: e.target.value })} />
                      </div>
                    </>
                  ) : null}
                  <div className="flex gap-2 sm:col-span-2">
                    <Button type="button" variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                      Up
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={i === form.rules.length - 1} onClick={() => move(i, 1)}>
                      Down
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => set({ rules: form.rules.filter((_, j) => j !== i) })}>
                      Remove rule
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => set({ rules: [...form.rules, { match: 'PREFIX', value: '', hide: false, greeting: '', message: '' }] })}>
                Add page rule
              </Button>
            </CardContent>
          </Card>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Can permission="campaigns.manage">
            <div>
              <Button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim() || !numberId}>
                {save.isPending ? 'Saving…' : 'Save button'}
              </Button>
            </div>
          </Can>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">Preview</CardTitle>
              <div className="flex gap-1" role="group" aria-label="Preview size">
                {(['desktop', 'phone'] as const).map((s) => (
                  <Button key={s} type="button" size="sm" variant={size === s ? 'default' : 'ghost'} aria-pressed={size === s} onClick={() => setSize(s)}>
                    {s === 'desktop' ? 'Desktop' : 'Phone'}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {preview ? (
                size === 'phone' ? <ScaledFrame key="phone" srcDoc={preview} width={375} height={667} /> : <ScaledFrame key="desktop" srcDoc={preview} width={1280} height={800} />
              ) : (
                <p className="text-sm text-muted-foreground">The preview needs the public link address on the server.</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">Click the button in the preview to see the greeting.</p>
            </CardContent>
          </Card>
          {w ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Snippet</CardTitle>
                  <CardDescription>Paste it once before the closing &lt;/body&gt; tag of your site.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                  <code className="break-all rounded bg-muted p-2 text-xs" data-testid="widget-snippet">
                    {w.snippet}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-self-start"
                    onClick={() => {
                      void navigator.clipboard?.writeText(w.snippet).catch(() => undefined);
                      toast.success('Snippet copied');
                    }}
                  >
                    Copy snippet
                  </Button>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Setup guide for your web team</summary>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      <li>If the site has a Content Security Policy, allow the link address in script-src, connect-src and img-src.</li>
                      <li>The script loads after the page, so it never slows it down.</li>
                      <li>To remove the button, delete the snippet or pause the button here.</li>
                    </ul>
                  </details>
                </CardContent>
              </Card>
              <Card data-testid="widget-stats">
                <CardHeader>
                  <CardTitle className="text-base">Last 30 days</CardTitle>
                  <CardDescription>
                    {formatNumber(w.last30Days.opens)} opens · {formatNumber(w.last30Days.chatsStarted)} chats started
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                  <div>
                    <div className="font-medium">Opens by page</div>
                    {(stats.data?.opensByPage ?? []).map((p) => (
                      <div key={p.page} className="flex justify-between gap-2">
                        <span className="truncate text-muted-foreground">{p.page}</span>
                        <span>{formatNumber(p.opens)}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div className="font-medium">Chats by page rule</div>
                    {(stats.data?.chatsByRule ?? []).map((r) => (
                      <div key={r.ruleId ?? 'default'} className="flex justify-between gap-2">
                        <span className="truncate text-muted-foreground">{r.label}</span>
                        <span>{formatNumber(r.chatsStarted)}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
