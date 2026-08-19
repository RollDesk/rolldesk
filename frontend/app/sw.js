// RollDesk service worker — browser notifications only.
//
// Deliberately not a cache: RollDesk is one HTML file plus two translation
// bundles served by nginx with explicit cache headers, and an offline shell would
// have to be invalidated on every release for no benefit — the app cannot get past
// the login screen without a reachable API anyway. So this worker installs, waits
// for pushes, and does nothing else.
//
// The payload arrives already composed (see backend/src/pushTargets.js): a title,
// two or three lines of body, a tag that collapses repeats for the same record,
// and the URL a click should open.

// Take over from a previous worker immediately rather than waiting for every tab
// to close. A release that changes notification handling should be in force on the
// next reload, not whenever someone finally shuts their last RollDesk tab.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // A push with no readable payload still means *something* happened, and a
  // browser that receives one and shows nothing may have its subscription revoked
  // (user-visible-only is a condition of the permission). So there is always a
  // notification, even if it can only say to open the app.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || 'RollDesk';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    // One notification per record: three date changes on the same rollout replace
    // each other instead of stacking three unread popups.
    tag: data.tag || 'rolldesk',
    renotify: true,
    // The icon is the app's own favicon — no extra asset to keep in step with a
    // release. Absent is fine: the browser falls back to its own.
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    // What the click needs, carried through rather than re-derived.
    data: { url: data.url || '/', event: data.event || '' },
    // Not requireInteraction: an operational notice that has to be dismissed by
    // hand becomes something people click away without reading.
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus a RollDesk tab that is already open rather than opening a second one —
    // the app holds its whole state in that tab, and a duplicate would start from
    // the login check. The hash is then set on the focused tab so the click still
    // lands on the record the notification was about.
    for (const client of all) {
      try {
        if (new URL(client.url).origin !== self.location.origin) continue;
      } catch (e) { continue; }
      await client.focus();
      // Only navigate when the notification actually names a record; a plain
      // "open the app" click must not throw away where the reader already was.
      if (target && target !== '/' && client.url !== target && 'navigate' in client) {
        try { await client.navigate(target); } catch (e) { /* focus alone is enough */ }
      }
      return;
    }
    await self.clients.openWindow(target || '/');
  })());
});

// A push service may tell us a subscription has been replaced. The page cannot
// see this event, so the worker asks every open tab to re-register; with no tab
// open the next visit re-subscribes anyway (see ensurePushSubscription in the app).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    all.forEach((client) => client.postMessage({ type: 'rolldesk:resubscribe' }));
  })());
});
