// Service worker for the single-file app shell. One of the two deliberate,
// narrow exceptions to CLAUDE.md's "one output file" rule (manifest.webmanifest
// is the other): a service worker cannot be registered from anything inline in
// the HTML document itself — browsers require a real, separately-fetchable
// same-origin URL — so both offline loading and Web Push genuinely require a
// second file. Nothing about the deploy process changes beyond the file count:
// Ryan drags daily-assistant.html + sw.js + manifest.webmanifest in, all three
// sit in the repo untouched.
//
// Two jobs:
//
// 1. Offline fallback (added post-Phase-8 — zero-signal access after iOS fully
//    kills the home-screen app's process). Network-first, not cache-first:
//    whenever there's any connectivity at all, this always fetches (and
//    re-caches) the current deployed version, so a future update is visible on
//    the very next open rather than lagging a version behind the way
//    cache-first-with-background-revalidate would. The cache is purely the
//    fallback for the one scenario it exists for — the fetch failing outright
//    (genuinely no connection) — never a shortcut taken just because a cached
//    copy happens to be sitting there.
//
// 2. Web Push (added later — the original spec's §5 said push "wasn't
//    feasible" because a home-screen web app had no push transport; iOS 16.4 /
//    macOS Safari 16.1 changed that). The `push` handler below just renders
//    whatever the Cloudflare relay Worker (see worker/) sends. The Worker is a
//    stateless relay: it reads the app's own public .ics feed, holds no app
//    data, and if it disappears the app falls back cleanly to its in-app
//    DeadlineReminders banners. This file never talks to the Worker directly —
//    NotificationSettings.jsx registers the subscription, the Worker pushes.
const CACHE_NAME = 'daily-assistant-shell-v2';
const SHELL_URL = 'daily-assistant.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(SHELL_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only the app shell's own top-level document load goes through this —
  // every other fetch this app makes (Gist sync to api.github.com, the
  // calendar CORS relay, a subscribed calendar feed) is a same-page fetch()
  // call, never a navigation, and must pass through completely untouched.
  // Intercepting those too would mean the app's own network-error handling
  // (syncOnce()'s halt(), the calendar refresh error message) receives this
  // file's generic offline placeholder instead of a real fetch failure,
  // turning a clear error into a confusing one.
  if (event.request.mode !== 'navigate') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        return (
          cached ||
          new Response('Offline, and nothing cached yet — open the app once with a connection first.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          })
        );
      })
  );
});

// --- Web Push -------------------------------------------------------------
// The relay Worker sends a JSON body: { title, body, tag, url }. Everything
// is defensively defaulted — a malformed or bodyless push still shows
// something rather than throwing inside the event and being dropped silently.
// `tag` collapses repeats of the same reminder into one banner instead of
// stacking; the Worker sets it per feed VEVENT UID.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data && event.data.text ? event.data.text() : '' };
  }

  const title = payload.title || 'Daily Assistant';
  const options = {
    body: payload.body || 'You have a reminder.',
    tag: payload.tag || 'daily-assistant-reminder',
    renotify: true,
    data: { url: payload.url || './daily-assistant.html' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tap the banner -> focus the already-open app if there is one, otherwise
// open it. Matches against the shell URL loosely (startsWith) because the
// home-screen launch and a browser tab can differ in query/hash.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './daily-assistant.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('daily-assistant') && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
