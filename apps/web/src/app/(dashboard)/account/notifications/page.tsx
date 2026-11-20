'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { queryKeys } from '@/lib/query';

interface PushDevice {
  id: string;
  label: string | null;
  paused: boolean;
  createdAt: string;
  lastSuccessAt: string | null;
}

/** FR-037: at most 5 browsers or devices per member (enforced by the API). */
const MAX_DEVICES = 5;

/** The VAPID key (base64url) as the bytes PushManager.subscribe expects. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(current: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((value, i) => value === key[i]);
}

/** Asks for permission, registers the service worker and subscribes this browser. */
async function subscribeThisBrowser(publicKey: string): Promise<PushSubscriptionJSON> {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Alerts are not allowed for this site in this browser.');
  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with an older server key cannot receive alerts any more.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return subscription.toJSON();
}

const noSubscribe = () => () => undefined;

/** Account > Alerts (T088, FR-037): the new-message sound and browser alerts on up to 5 devices. */
export default function NotificationsPage() {
  return (
    <RequirePermission permission="inbox.view">
      <Alerts />
    </RequirePermission>
  );
}

function Alerts() {
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: queryKeys.notificationPrefs, queryFn: () => api<{ soundEnabled: boolean }>('/me/notification-preferences') });
  const devices = useQuery({ queryKey: queryKeys.pushDevices, queryFn: () => api<PushDevice[]>('/me/push-devices') });
  const vapid = useQuery({ queryKey: ['push-key'], queryFn: () => api<{ publicKey: string | null }>('/push/vapid-public-key'), staleTime: Infinity });
  const supported = useSyncExternalStore(noSubscribe, () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window, () => false);
  const permission = useSyncExternalStore(noSubscribe, () => ('Notification' in window ? Notification.permission : 'default'), () => 'default');
  const refreshDevices = () => void queryClient.invalidateQueries({ queryKey: queryKeys.pushDevices });

  const sound = useMutation({
    mutationFn: (soundEnabled: boolean) => api<{ soundEnabled: boolean }>('/me/notification-preferences', { method: 'PUT', json: { soundEnabled } }),
    onMutate: (soundEnabled) => queryClient.setQueryData(queryKeys.notificationPrefs, { soundEnabled }),
    onSuccess: (saved) => queryClient.setQueryData(queryKeys.notificationPrefs, saved),
    onError: (_error, soundEnabled) => {
      queryClient.setQueryData(queryKeys.notificationPrefs, { soundEnabled: !soundEnabled });
      toast.error('The sound setting could not be saved');
    },
  });
  const turnOn = useMutation({
    mutationFn: async (publicKey: string) => {
      const subscription = await subscribeThisBrowser(publicKey);
      return api<PushDevice>('/me/push-devices', {
        method: 'POST',
        json: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys?.p256dh, auth: subscription.keys?.auth } },
      });
    },
    onSuccess: () => {
      toast.success('Alerts are on for this browser');
      refreshDevices();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Alerts could not be turned on'),
  });
  const pause = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => api<PushDevice>(`/me/push-devices/${id}`, { method: 'PATCH', json: { paused } }),
    onSuccess: refreshDevices,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The device could not be changed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/me/push-devices/${id}`, { method: 'DELETE' }),
    onSuccess: refreshDevices,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The device could not be removed'),
  });

  const publicKey = vapid.data?.publicKey ?? null;
  const blocker =
    vapid.data && publicKey === null
      ? 'Browser alerts are not set up on this server yet: an administrator needs to add the push keys.'
      : !supported
        ? 'This browser does not support alerts.'
        : permission === 'denied'
          ? "Alerts are blocked for this site in this browser's settings."
          : null;

  return (
    <div className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold">Alerts</h1>
      <Card>
        <CardHeader>
          <CardTitle>Sound</CardTitle>
          <CardDescription>A short chime when a customer writes in a chat you can see, while the dashboard is open in this browser.</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={prefs.data?.soundEnabled ?? true} disabled={!prefs.data || sound.isPending} onChange={(e) => sound.mutate(e.target.checked)} />
            Play a sound for new customer messages
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Browser alerts</CardTitle>
          <CardDescription>
            Alerts while the dashboard is closed: new customer messages in chats you can see, chats waiting for an agent, chats transferred to
            you, and mentions. Up to {MAX_DEVICES} browsers or devices. How alerts look depends on the browser and the device.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {blocker && <p className="text-sm text-muted-foreground">{blocker}</p>}
          <div>
            <Button onClick={() => publicKey && turnOn.mutate(publicKey)} disabled={Boolean(blocker) || !publicKey || turnOn.isPending}>
              {turnOn.isPending ? 'Turning on…' : 'Turn on alerts for this browser'}
            </Button>
          </div>
          <ul className="grid gap-2" aria-label="Browsers and devices">
            {devices.data?.map((device) => (
              <li key={device.id} data-testid="push-device" className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    {device.label ?? 'Browser'}
                    {device.paused && <Badge variant="secondary">Paused</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Added {new Date(device.createdAt).toLocaleDateString()} ·{' '}
                    {device.lastSuccessAt ? `last alert ${new Date(device.lastSuccessAt).toLocaleString()}` : 'no alerts yet'}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={pause.isPending} onClick={() => pause.mutate({ id: device.id, paused: !device.paused })}>
                    {device.paused ? 'Resume' : 'Pause'}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive" disabled={remove.isPending} onClick={() => remove.mutate(device.id)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
            {devices.data?.length === 0 && <li className="text-sm text-muted-foreground">No browsers or devices yet.</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
