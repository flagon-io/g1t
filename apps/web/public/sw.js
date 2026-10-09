// g1t's service worker: browser notifications, nothing else. It caches
// nothing and answers no requests, so pages load exactly as without it.
// Pushes come from the notify service (services/notify), encrypted for
// this browser: { title, body, href, tag, kind, urgent, workspace, actions,
// card }. A notification about a chat card (a session at its cap, a draft
// issue) has buttons for the card's actions that need nothing typed: a
// link opens its page; the others are pressed here, as on the card, by
// posting `card_action` to the site, and the answer shows as a notification.

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
  const safe = (href) => (typeof href === "string" && href.startsWith("/") && !href.startsWith("//") ? href : null);
  const actions = Array.isArray(data.actions)
    ? data.actions
        .filter((a) => a && typeof a.id === "string" && typeof a.label === "string")
        .slice(0, 2)
        .map((a) => ({ id: a.id, label: a.label, href: safe(a.href) }))
    : [];
  const card =
    data.card && typeof data.card.channel_id === "string" && typeof data.card.message_id === "string" && typeof data.workspace === "string"
      ? { workspace: data.workspace, channel_id: data.card.channel_id, message_id: data.card.message_id }
      : null;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      // One notification per conversation: a newer message replaces the last.
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      actions: actions.map((a) => ({ action: a.id, title: a.label })),
      data: { href: safe(data.href) || "/", actions, card },
    }),
  );
});

/** Presses a card's action for the person, with their session, and says what happened. */
async function pressCard(card, action, title) {
  let message = `${action.label} didn't go through. Open g1t to try again.`;
  try {
    const response = await fetch(`/${encodeURIComponent(card.workspace)}/-/chat/api`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "card_action", channel_id: card.channel_id, message_id: card.message_id, action_id: action.id, input: null }),
    });
    const result = await response.json();
    if (result && result.ok) message = result.value.message || (result.value.ok ? `${action.label}: done.` : `${action.label} didn't work.`);
    else if (result && result.error && result.error.message) message = result.error.message;
  } catch {
    // Offline, or signed out: the message above says so.
  }
  await self.registration.showNotification(title || "g1t", { body: message, icon: "/icon-192.png", badge: "/badge-96.png", tag: `card:${card.message_id}` });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const pressed = event.action && Array.isArray(data.actions) ? data.actions.find((a) => a.id === event.action) : null;
  if (pressed && !pressed.href && data.card) {
    event.waitUntil(pressCard(data.card, pressed, event.notification.title));
    return;
  }
  const href = (pressed && pressed.href) || data.href || "/";
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
