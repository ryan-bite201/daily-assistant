// Offline fallback for the single-file app shell (added post-Phase-8, per
// Ryan's request — worried about zero-signal access after iOS fully kills
// the home-screen app's process). This is the one deliberate, narrow
// exception to CLAUDE.md's "one output file" rule: a service worker cannot
// be registered from anything inline in the HTML document itself (browsers
// require a real, separately-fetchable same-origin URL for this — the
// original spec's own §5 already noted the same restriction when explaining
// why push notifications weren't feasible), so guaranteed offline loading
// genuinely requires a second file. Its only job is caching
// daily-assistant.html; nothing else about the deploy process changes —
// Ryan still just drags the one HTML file in, this sits in the repo
// untouched.
//
// Network-first, not cache-first: whenever there's any connectivity at all,
// this always fetches (and re-caches) the current deployed version, so a
// future update is visible on the very next open rather than lagging a
// version behind the way cache-first-with-background-revalidate would. The
// cache is purely the fallback for the one scenario this exists for — the
// fetch failing outright (genuinely no connection) — never a shortcut taken
// just because a cached copy happens to be sitting there.
const CACHE_NAME = 'daily-assistant-shell-v1';
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
