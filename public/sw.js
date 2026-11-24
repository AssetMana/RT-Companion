// RT Systems Companion: kept on the phone, so it opens at once.
// The app's own files are kept here and refreshed in the background each
// time it opens (the newest is used the time after); the list of the
// pocket's files is always asked for fresh, with the kept one when
// there's no answer. The pocket's files themselves carry their release in
// their address and the browser keeps them (the relay says for how long).
'use strict';
const CACHE = 'rt-companion-368';   // (tools/companion_pack.py puts the release here)
const SHELL = ['./', 'index.html', 'app.js', 'worker.js', 'fengari.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// alerts while the app is closed (the relay sends them: relay.js)
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = {body: e.data ? e.data.text() : ''}; }
  const shown = self.registration.showNotification(m.title || 'RT Systems', {body: m.body || '', tag: m.tag || 'rt', icon: 'icon-192.png', badge: 'icon-192.png', renotify: true,
    data: {kind: m.kind, text: m.text, ref: m.ref}});
  // (the Home Screen icon's count, where the phone shows one)
  const badge = typeof m.badge === 'number' && self.navigator && self.navigator.setAppBadge
    ? (m.badge > 0 ? self.navigator.setAppBadge(m.badge) : self.navigator.clearAppBadge()).catch(() => {}) : Promise.resolve();
  e.waitUntil(Promise.all([shown, badge]));
});
// tapped: the app comes up and opens on what it was about (app.js passes
// it to the pocket, as a notice tapped in game)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const open = e.notification.data && e.notification.data.kind ? e.notification.data : null;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then((list) => {
    for (const c of list) {
      if ('focus' in c) { if (open) c.postMessage({open}); return c.focus(); }
    }
    return self.clients.openWindow(open ? './#open=' + encodeURIComponent(JSON.stringify(open)) : './');
  }));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/pocket/manifest.json')) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request)));
    return;
  }
  if (url.pathname.includes('/pocket/') || url.pathname === '/healthz' || url.pathname.endsWith('/push-key')) return;
  e.respondWith(caches.open(CACHE).then((c) => c.match(e.request, {ignoreSearch: false}).then((hit) => {
    const fresh = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || fresh;
  })));
});
