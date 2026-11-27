'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { usePermissions } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Template, WhatsAppNumber } from '@/lib/types';

// Feature 009 US1 (T029): the default one-time code template and number, the per-phone limit, and the
// last 24 hours. Company systems send codes with POST /api/v1/otp and a key that has "Send one-time codes".

interface OtpSettings {
  defaultTemplateId: string | null;
  defaultNumberId: string | null;
  limitPerPhone: number;
  limitWindowMinutes: number;
  last24h: { requested: number; sent: number; delivered: number; failed: number; expired: number; refusedByLimit: number };
}

const otpKey = ['otp-settings'] as const;

export default function OneTimeCodesSettingsPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const settings = useQuery({ queryKey: otpKey, queryFn: () => api<OtpSettings>('/otp/settings') });
  const templates = useQuery({ queryKey: ['templates', 'APPROVED'], queryFn: () => api<Template[]>('/templates?status=APPROVED') });
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const [form, setForm] = useState({ defaultTemplateId: '', defaultNumberId: '', limitPerPhone: 5, limitWindowMinutes: 15 });

  useEffect(() => {
    if (settings.data) {
      setForm({
        defaultTemplateId: settings.data.defaultTemplateId ?? '',
        defaultNumberId: settings.data.defaultNumberId ?? '',
        limitPerPhone: settings.data.limitPerPhone,
        limitWindowMinutes: settings.data.limitWindowMinutes,
      });
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api<OtpSettings>('/otp/settings', {
        method: 'PUT',
        json: { defaultTemplateId: form.defaultTemplateId || null, defaultNumberId: form.defaultNumberId || null, limitPerPhone: form.limitPerPhone, limitWindowMinutes: form.limitWindowMinutes },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(otpKey, data);
      toast.success('One-time code settings saved');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const codeTemplates = (templates.data ?? []).filter((t) => t.kind === 'AUTHENTICATION');
  const editable = can('settings.manage');
  const last = settings.data?.last24h;

  return (
    <div className="grid gap-6">
      <div>
        <h2 className="text-lg font-semibold">One-time codes</h2>
        <p className="text-sm text-muted-foreground">
          Your website or app makes a code and sends it with <code>POST /api/v1/otp</code> and an API key that has &quot;Send one-time codes&quot;. Codes go out before campaigns, and
          nobody can read a code after it is sent.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Defaults and limit</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="otp-template">Code template</Label>
            <NativeSelect id="otp-template" disabled={!editable} value={form.defaultTemplateId} onChange={(e) => setForm({ ...form, defaultTemplateId: e.target.value })}>
              <option value="">Choose an approved code template…</option>
              {codeTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="otp-number">Number</Label>
            <NativeSelect id="otp-number" disabled={!editable} value={form.defaultNumberId} onChange={(e) => setForm({ ...form, defaultNumberId: e.target.value })}>
              <option value="">First connected number of the template&apos;s account</option>
              {(numbers.data ?? [])
                .filter((n) => n.connectionStatus === 'CONNECTED')
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label ?? n.displayPhoneNumber}
                  </option>
                ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="otp-limit">Codes per phone number</Label>
            <Input id="otp-limit" type="number" min={1} max={50} disabled={!editable} value={form.limitPerPhone} onChange={(e) => setForm({ ...form, limitPerPhone: Number(e.target.value) })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="otp-window">In (minutes)</Label>
            <Input id="otp-window" type="number" min={1} max={1440} disabled={!editable} value={form.limitWindowMinutes} onChange={(e) => setForm({ ...form, limitWindowMinutes: Number(e.target.value) })} />
          </div>
          {editable ? (
            <div className="sm:col-span-2">
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save settings'}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      {last ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last 24 hours</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3" data-testid="otp-last-24h">
            <div>Requested: {last.requested}</div>
            <div>Sent: {last.sent}</div>
            <div>Delivered: {last.delivered}</div>
            <div>Failed: {last.failed}</div>
            <div>Not delivered in time: {last.expired}</div>
            <div>Refused by the limit: {last.refusedByLimit}</div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
