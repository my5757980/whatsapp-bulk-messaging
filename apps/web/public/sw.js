/* Live chat browser alerts (feature 002, T088, research R9).
 * Shows the push alert sent by the worker and, on click, focuses an open dashboard tab on the
 * chat or opens a new one. The payload is { title, body, url, tag }; a newer alert for the same
 * chat replaces the older one (same tag). */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  if (!data || typeof data !== 'object') data = {};
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/inbox';
  event.waitUntil(
    self.registration.showNotification(typeof data.title === 'string' && data.title ? data.title : 'Live chat', {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data && typeof event.notification.data.url === 'string' ? event.notification.data.url : '/inbox';
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const sameOrigin = windows.filter((client) => new URL(client.url).origin === self.location.origin);
      const inboxTab = sameOrigin.find((client) => new URL(client.url).pathname.startsWith('/inbox'));
      const tab = inboxTab ?? sameOrigin[0];
      if (tab) {
        try {
          const focused = await tab.focus();
          await (focused ?? tab).navigate(target);
          return;
        } catch {
          // An uncontrolled tab cannot be navigated from here; open the chat in a new one.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
