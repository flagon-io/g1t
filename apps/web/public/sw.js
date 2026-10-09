// g1t's service worker: browser notifications, nothing else. It caches
// nothing and answers no requests, so pages load exactly as without it.
// Pushes come from the notify service (services/notify), encrypted for
// this browser: { title, body, href, tag, kind, urgent }.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "g1t", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "g1t";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      // One notification per conversation: a newer message replaces the last.
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { href: typeof data.href === "string" && data.href.startsWith("/") && !data.href.startsWith("//") ? data.href : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || "/";
  const target = new URL(href, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // A tab already on g1t: brought forward and moved there.
      const tab = open.find((client) => new URL(client.url).origin === self.location.origin);
      if (tab) {
        await tab.focus();
        if ("navigate" in tab) {
          try {
            await tab.navigate(target);
            return;
          } catch {
            // Not ours to navigate (uncontrolled): told instead.
          }
        }
        tab.postMessage({ type: "g1t:navigate", href });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
