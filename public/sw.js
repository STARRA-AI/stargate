/* STARGATE service worker — DISABLED / self-healing kill-switch.
 *
 * The previous version cached JS chunks and, on any failed request, fell back to
 * returning the HTML page ("/"). After a rebuild the chunk hashes change, the
 * stale request 404s, and the browser gets HTML where it expected JavaScript ->
 * "Application error: a client-side exception has occurred." This version does
 * the opposite: it clears every cache, unregisters itself, and reloads any
 * controlled page so clients recover to a clean, network-only state. No fetch
 * handler — all requests go straight to the network (always-fresh chunks).
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* ignore */
      }
      try {
        await self.registration.unregister();
      } catch {
        /* ignore */
      }
      // Reload every page this SW was controlling so it re-fetches fresh chunks.
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        for (const c of clients) c.navigate(c.url);
      } catch {
        /* ignore */
      }
    })(),
  );
});
