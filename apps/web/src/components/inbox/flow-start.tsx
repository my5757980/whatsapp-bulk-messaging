'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { toastError } from '@/lib/errors';

/** The flow answering a chat (contracts/flows-api.openapi.yaml RunningSession). */
export interface RunningFlow {
  sessionId: string;
  flowId: string;
  flowName: string;
  stepId: string | null;
  startedAt: string;
  startedBy: 'TRIGGER' | 'MEMBER' | 'JUMP';
  test?: boolean;
}

export const flowSessionKey = (chatId: string) => ['inbox', 'flow-session', chatId] as const;

const STARTED_BY: Record<RunningFlow['startedBy'], string> = {
  TRIGGER: 'started by the customer',
  MEMBER: 'started by a member',
  JUMP: 'continued from another flow',
};

/**
 * Above the reply box while a chatbot flow answers the chat (003 T044): members see that a flow is
 * talking, and that replying or taking the chat stops it. `refreshKey` changes with new chat items
 * and state changes (002 live events), so the banner follows the session.
 */
export function FlowSessionBanner({ chatId, refreshKey }: { chatId: string; refreshKey: string }) {
  const session = useQuery({
    queryKey: [...flowSessionKey(chatId), refreshKey],
    queryFn: () => api<RunningFlow | null>(`/inbox/conversations/${chatId}/flow-session`),
  });
  if (!session.data) return null;
  return (
    <div role="status" data-testid="flow-banner" className="border-t bg-accent/60 px-4 py-2 text-xs">
      <span className="font-medium">Flow “{session.data.flowName}” is answering</span> ({STARTED_BY[session.data.startedBy]}
      {session.data.test ? ', test run' : ''}). Replying or taking the chat stops it.
    </div>
  );
}

/** Starts a published flow for this customer (FR-031); a flow already answering is interrupted. */
export function StartFlowButton({ chatId, disabled = false }: { chatId: string; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [flowId, setFlowId] = useState('');
  const flows = useQuery({
    queryKey: ['inbox', 'chat-flows', chatId],
    queryFn: () => api<Array<{ id: string; name: string }>>(`/inbox/conversations/${chatId}/flows`),
    enabled: open,
  });
  const start = useMutation({
    mutationFn: () => api<RunningFlow>(`/inbox/conversations/${chatId}/flows`, { method: 'POST', json: { flowId } }),
    onSuccess: (session) => {
      toast.success(`Flow “${session.flowName}” started`);
      setOpen(false);
      setFlowId('');
      void queryClient.invalidateQueries({ queryKey: flowSessionKey(chatId) });
    },
    onError: toastError,
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          Start a flow
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a flow</DialogTitle>
          <DialogDescription>
            The flow answers this customer now; a flow already answering stops. Flows need the customer&apos;s 24-hour window to be open.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Label htmlFor="start-flow">Flow</Label>
          <NativeSelect id="start-flow" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
            <option value="">{flows.isLoading ? 'Loading…' : flows.data?.length ? 'Choose a flow' : 'No published flow serves this number'}</option>
            {flows.data?.map((flow) => (
              <option key={flow.id} value={flow.id}>
                {flow.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <DialogFooter>
          <Button onClick={() => start.mutate()} disabled={!flowId || start.isPending}>
            {start.isPending ? 'Starting…' : 'Start flow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
