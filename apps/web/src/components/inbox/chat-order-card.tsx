'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMinor } from '@wbm/shared';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { CART_WARNING_LABEL, CHAT_ORDER_STATUS_LABEL, catalogKeys, type ChatOrder } from '@/lib/catalog';
import { toastError } from '@/lib/errors';
import { usePermissions } from '@/lib/permissions';

const STATUS_VARIANT: Record<ChatOrder['status'], 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  RECEIVED: 'warning',
  LINK_SENT: 'secondary',
  PAID: 'success',
  EXPIRED: 'outline',
  CANCELLED: 'outline',
  REFUNDED: 'destructive',
};

/**
 * A cart sent in chat (feature 008 US6, FR-026 – FR-029): items, total and warnings; before the link
 * is sent an agent can change quantities, remove items, send the link or cancel.
 */
export function ChatOrderCard({ orderId }: { orderId: string }) {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const order = useQuery({ queryKey: catalogKeys.order(orderId), queryFn: () => api<ChatOrder>(`/chat-orders/${orderId}`) });
  const [quantities, setQuantities] = useState<Record<string, number> | null>(null);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: catalogKeys.order(orderId) }), queryClient.invalidateQueries({ queryKey: ['payments'] })]);
  const save = useMutation({
    mutationFn: (items: Array<{ retailerId: string; quantity: number }>) => api<ChatOrder>(`/chat-orders/${orderId}`, { method: 'PATCH', json: { items } }),
    onSuccess: () => {
      setQuantities(null);
      toast.success('Order changed');
      return refresh();
    },
    onError: toastError,
  });
  const sendLink = useMutation({
    mutationFn: () => api<ChatOrder>(`/chat-orders/${orderId}/send-link`, { method: 'POST', json: {} }),
    onSuccess: () => {
      toast.success('Payment link sent');
      return refresh();
    },
    onError: toastError,
  });
  const cancel = useMutation({
    mutationFn: () => api<ChatOrder>(`/chat-orders/${orderId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Order cancelled');
      return refresh();
    },
    onError: toastError,
  });
  const o = order.data;
  if (!o) return <p className="text-xs text-muted-foreground">Loading the order…</p>;
  const editable = o.status === 'RECEIVED' && can('inbox.reply');
  const editing = quantities !== null;
  const shown = editing ? o.items.filter((i) => (quantities[i.retailerId] ?? 0) > 0) : o.items;
  const total = editing ? shown.filter((i) => i.currency === o.currency).reduce((sum, i) => sum + (quantities[i.retailerId] ?? i.quantity) * i.itemPriceMinor, 0) : o.totalMinor;

  return (
    <div className="grid gap-2 rounded-md border bg-background p-2 text-sm" data-testid={`chat-order-${o.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Order</span>
        <Badge variant={STATUS_VARIANT[o.status]} data-testid="chat-order-status">
          {CHAT_ORDER_STATUS_LABEL[o.status]}
        </Badge>
      </div>
      <ul className="grid gap-1" aria-label="Order items">
        {o.items.map((item) => (
          <li key={item.retailerId} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex-1">{item.name ?? item.retailerId}</span>
            {editing ? (
              <Input
                type="number"
                min={0}
                max={999}
                aria-label={`Quantity of ${item.name ?? item.retailerId}`}
                className="h-7 w-16"
                value={quantities[item.retailerId] ?? item.quantity}
                onChange={(e) => setQuantities({ ...quantities, [item.retailerId]: Math.max(0, Math.min(999, Number(e.target.value) || 0)) })}
              />
            ) : (
              <span>× {item.quantity}</span>
            )}
            <span className="tabular-nums">{formatMinor(item.itemPriceMinor * (editing ? (quantities[item.retailerId] ?? item.quantity) : item.quantity), item.currency)}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-between border-t pt-1 font-medium">
        <span>Total</span>
        <span className="tabular-nums" data-testid="chat-order-total">
          {formatMinor(total, o.currency)}
        </span>
      </div>
      {o.customerText ? <p className="text-xs text-muted-foreground">“{o.customerText}”</p> : null}
      {o.warnings.length ? (
        <ul className="grid gap-0.5 text-xs text-warning-foreground" aria-label="Warnings" data-testid="chat-order-warnings">
          {o.warnings.map((w, i) => (
            <li key={`${w.kind}-${w.retailerId ?? i}`}>
              ⚠ {CART_WARNING_LABEL[w.kind]}
              {w.detail ? `: ${w.detail}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                disabled={save.isPending || shown.length === 0}
                onClick={() => save.mutate(shown.map((i) => ({ retailerId: i.retailerId, quantity: quantities[i.retailerId] ?? i.quantity })))}
              >
                Save changes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setQuantities(null)}>
                Undo
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => sendLink.mutate()} disabled={sendLink.isPending}>
                Send payment link
              </Button>
              <Button size="sm" variant="outline" onClick={() => setQuantities(Object.fromEntries(o.items.map((i) => [i.retailerId, i.quantity])))}>
                Change items
              </Button>
              <Button size="sm" variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                Cancel order
              </Button>
            </>
          )}
        </div>
      ) : o.status === 'LINK_SENT' && can('inbox.reply') ? (
        <Button size="sm" variant="outline" className="justify-self-start" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          Cancel order
        </Button>
      ) : null}
    </div>
  );
}
