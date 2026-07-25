"use client";

import { useEffect } from "react";

/**
 * The deck's service worker was caching JS chunks and serving the HTML shell for
 * failed requests, which crashed the deck with a client-side exception after any
 * rebuild (stale chunk hashes). We no longer register a caching SW. Instead, on
 * every load we unregister any lingering SW and wipe its caches, so browsers that
 * still hold the old one recover to a clean, network-only state.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => void r.unregister()))
        .catch(() => {});
    }
    if ("caches" in window) {
      caches
        .keys()
        .then((keys) => keys.forEach((k) => void caches.delete(k)))
        .catch(() => {});
    }
  }, []);
  return null;
}
