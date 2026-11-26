'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { toastError } from '@/lib/errors';
import type { FlowDetail } from '@/lib/flows';
import { paymentMoney, paymentsKeys, type PaymentRequest } from '@/lib/payments';

const MAX_TEST_NUMBERS = 3;
const slots = (numbers: string[]) => [...numbers, '', '', ''].slice(0, MAX_TEST_NUMBERS);

/**
 * Test numbers (003 T072, FR-034): up to three phones whose messages run the draft, so changes can
 * be tried before publishing. Their chats are marked "test" and left out of analytics.
 */
export function TestPanel({ flowId, testNumbers }: { flowId: string; testNumbers: string[] }) {
  const [values, setValues] = useState(() => slots(testNumbers));
  const save = useMutation({
    mutationFn: () => api<FlowDetail>(`/flows/${flowId}`, { method: 'PATCH', json: { testNumbers: values.map((v) => v.trim()).filter(Boolean) } }),
    onSuccess: (flow) => {
      setValues(slots(flow.testNumbers));
      toast.success(flow.testNumbers.length ? 'Test numbers saved' : 'Test numbers removed');
    },
    onError: toastError,
  });

  return (
    <section aria-labelledby="test-title" className="grid gap-2 rounded-lg border bg-card p-3">
      <div>
        <h2 id="test-title" className="text-sm font-semibold">
          Test numbers
        </h2>
        <p className="text-xs text-muted-foreground">Messages from these phones run the draft. Their chats show &quot;test&quot; and are left out of analytics.</p>
      </div>
      {values.map((value, i) => (
        <Input
          key={i}
          aria-label={`Test number ${i + 1}`}
          value={value}
          maxLength={20}
          placeholder="+971 50 123 4567"
          onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
        />
      ))}
      <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => save.mutate()} disabled={save.isPending}>
        Save test numbers
      </Button>
      <TestPayments flowId={flowId} />
    </section>
  );
}

/**
 * Payment steps in test chats (feature 008 US3, R13): a test request is never paid for real; these
 * buttons send the waiting test session down its paid or not-paid branch.
 */
function TestPayments({ flowId }: { flowId: string }) {
  const queryClient = useQueryClient();
  const filters = { testFlowId: flowId, status: 'WAITING', includeTest: true };
  const waiting = useQuery({
    queryKey: paymentsKeys.requests(filters),
    queryFn: () => api<{ items: PaymentRequest[] }>(`/payments/requests?testFlowId=${flowId}&status=WAITING&includeTest=true`),
    refetchInterval: 5_000,
  });
  const drive = useMutation({
    mutationFn: ({ id, result }: { id: string; result: 'paid' | 'notPaid' }) => api<PaymentRequest>(`/payments/requests/${id}/test-result`, { method: 'POST', json: { result } }),
    onSuccess: (_row, { result }) => {
      toast.success(result === 'paid' ? 'Marked paid: the flow takes the paid branch' : 'Marked not paid: the flow takes the not-paid branch');
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
    },
    onError: toastError,
  });
  const items = waiting.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="grid gap-2 border-t pt-2">
      <p className="text-xs font-medium">Test payments waiting</p>
      {items.map((r) => (
        <div key={r.id} className="grid gap-1 rounded-md border p-2 text-xs">
          <span>
            {paymentMoney(r.amountMinor, r.currency)} · {r.description} · {r.phone ?? 'test chat'}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => drive.mutate({ id: r.id, result: 'paid' })} disabled={drive.isPending}>
              Mark paid (test)
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => drive.mutate({ id: r.id, result: 'notPaid' })} disabled={drive.isPending}>
              Mark not paid (test)
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
