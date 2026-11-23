'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { TEXTAREA_CLASS } from '@/components/flows/steps/form-bits';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { aiKeys, type AiSettings, type AiUsage } from '@/lib/ai';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatNumber } from '@/lib/format';

const money = (usd: number) => `$${usd.toFixed(usd < 1 ? 4 : 2)}`;

/** AI usage (004 T090, FR-037–FR-039): replies against the monthly limit, cost, outcomes and the limits. */
export default function AiUsagePage() {
  return (
    <RequirePermission permission="ai.usage">
      <UsageView />
    </RequirePermission>
  );
}

function UsageView() {
  const [month, setMonth] = useState('');
  const usage = useQuery({ queryKey: aiKeys.usage(month), queryFn: () => api<AiUsage>(`/ai-usage${month ? `?month=${month}` : ''}`) });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">AI usage</h1>
          <p className="text-sm text-muted-foreground">Replies your AI agents sent, what they cost, and the monthly limit. Months follow the company time zone.</p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="usage-month">Month</Label>
          <Input id="usage-month" type="month" className="w-44" value={month || usage.data?.month || ''} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>

      {usage.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : usage.error || !usage.data ? (
        <p className="text-sm text-destructive">{errorMessage(usage.error)}</p>
      ) : (
        <UsageReport data={usage.data} />
      )}

      <LimitsForm />
    </div>
  );
}

function UsageReport({ data }: { data: AiUsage }) {
  const share = data.replyLimit > 0 ? Math.min(100, Math.round((data.replies / data.replyLimit) * 100)) : 100;
  const c = data.conversations;
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">AI replies</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            <p className="text-2xl font-semibold" data-testid="usage-replies">
              {formatNumber(data.replies)} <span className="text-base font-normal text-muted-foreground">of {formatNumber(data.replyLimit)}</span>
            </p>
            <div className="h-2 rounded bg-muted" role="progressbar" aria-label="Share of the monthly limit used" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
              <div className={`h-2 rounded ${share >= 100 ? 'bg-destructive' : share >= 80 ? 'bg-warning' : 'bg-primary'}`} style={{ width: `${share}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{formatNumber(data.testReplies)} of them from test numbers</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Estimated cost</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold" data-testid="usage-cost">
              {money(data.estimatedCostUsd)}
            </p>
            <p className="text-xs text-muted-foreground">From the measured tokens and your prices</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Preview turns</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatNumber(data.previewTurns)}</p>
            <p className="text-xs text-muted-foreground">Tries in the editor; not counted as replies</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Assistant requests</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {formatNumber(data.assistantRequests)} <span className="text-base font-normal text-muted-foreground">of {formatNumber(data.assistantLimit)}</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How AI conversations ended</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-6" data-testid="usage-outcomes">
            {[
              ['Answered by the agent', c.answered],
              ['Handed over', c.handedOver],
              ['Taken by a member', c.memberTook],
              ['Limit reached', c.limitReached],
              ['Error', c.failed],
              ['Other', c.other],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-lg font-semibold">{formatNumber(value as number)}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per agent</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.byAgent.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">No AI replies this month.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Replies</TableHead>
                    <TableHead className="text-right">Test replies</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byAgent.map((a) => (
                    <TableRow key={a.agentId} data-testid="usage-agent-row">
                      <TableCell>{a.name}</TableCell>
                      <TableCell className="text-right">{formatNumber(a.replies)}</TableCell>
                      <TableCell className="text-right">{formatNumber(a.testReplies)}</TableCell>
                      <TableCell className="text-right">{money(a.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per day</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.byDay.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">No AI use this month.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead className="text-right">Replies</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byDay.map((d) => (
                    <TableRow key={d.day}>
                      <TableCell>{d.day}</TableCell>
                      <TableCell className="text-right">{formatNumber(d.replies)}</TableCell>
                      <TableCell className="text-right">{money(d.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function LimitsForm() {
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: aiKeys.settings, queryFn: () => api<AiSettings>('/ai-settings') });
  const [form, setForm] = useState<AiSettings | null>(null);
  useEffect(() => {
    if (current.data && !form) setForm(current.data);
  }, [current.data, form]);
  const save = useMutation({
    mutationFn: (body: AiSettings) => api<AiSettings>('/ai-settings', { method: 'PUT', json: body }),
    onSuccess: (saved) => {
      setForm(saved);
      queryClient.setQueryData(aiKeys.settings, saved);
      void queryClient.invalidateQueries({ queryKey: ['ai-usage'] });
      toast.success('AI limits saved');
    },
    onError: toastError,
  });

  if (!form) return null;
  const num = (value: string) => (value === '' ? 0 : Number(value));
  const setPrice = (key: keyof AiSettings['prices'], value: string) => setForm({ ...form, prices: { ...form.prices, [key]: key === 'model' ? value : num(value) } });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ ...form, limitMessage: form.limitMessage?.trim() ? form.limitMessage : null });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Limits and prices</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="limit-replies">AI replies per month</Label>
              <Input id="limit-replies" type="number" min={0} max={1_000_000} value={form.replyLimit} onChange={(e) => setForm({ ...form, replyLimit: num(e.target.value) })} />
              <p className="text-xs text-muted-foreground">Admins are alerted at 80% and 100%. At the limit, new messages go to your team.</p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="limit-assistant">Assistant requests per month</Label>
              <Input id="limit-assistant" type="number" min={0} max={100_000} value={form.assistantLimit} onChange={(e) => setForm({ ...form, assistantLimit: num(e.target.value) })} />
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="limit-message">Message to the customer at the limit (optional)</Label>
            <textarea
              id="limit-message"
              className={TEXTAREA_CLASS}
              maxLength={500}
              value={form.limitMessage ?? ''}
              placeholder="Thanks for your message. Our team will reply shortly."
              onChange={(e) => setForm({ ...form, limitMessage: e.target.value })}
            />
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Prices in USD per million tokens</legend>
            <div className="grid gap-3 md:grid-cols-5">
              <div className="grid gap-1">
                <Label htmlFor="price-model">Model</Label>
                <Input id="price-model" value={form.prices.model} maxLength={60} onChange={(e) => setPrice('model', e.target.value)} />
              </div>
              {(
                [
                  ['input', 'Input'],
                  ['output', 'Output'],
                  ['cacheRead', 'Cache read'],
                  ['cacheWrite', 'Cache write'],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="grid gap-1">
                  <Label htmlFor={`price-${key}`}>{label}</Label>
                  <Input id={`price-${key}`} type="number" min={0} step="0.01" value={form.prices[key]} onChange={(e) => setPrice(key, e.target.value)} />
                </div>
              ))}
            </div>
          </fieldset>
          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save limits'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
