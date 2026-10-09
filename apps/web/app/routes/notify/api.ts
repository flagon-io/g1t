import { env } from "cloudflare:workers";
import { data } from "react-router";

import { notifyClient, type NotifyPreferencesChange, type PresenceChange, type PushSubscriptionJson } from "@g1t/contracts";

import type { Route } from "./+types/api";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

function client() {
  if (!env.NOTIFY) throw data({ error: "Notifications are not set up here." }, { status: 503 });
  return notifyClient(env.NOTIFY);
}

/**
 * The signed-in person's notification settings, as JSON: `GET` their
 * status (with `?endpoint=` for whether this browser gets pushes), `POST`
 * a change: `subscribe`, `unsubscribe`, `preferences`, `test`, or
 * `presence` (your status, being away, Do Not Disturb).
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const endpoint = new URL(request.url).searchParams.get("endpoint");
  const status = await client().status(user, endpoint);
  return Response.json(status, { headers: { "cache-control": "no-store" } });
}

type Sent = {
  intent?: string;
  subscription?: PushSubscriptionJson & { expirationTime?: number | null };
  endpoint?: string;
  preferences?: NotifyPreferencesChange;
  change?: PresenceChange;
};

export async function action({ context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const sent = (await request.json().catch(() => ({}))) as Sent;
  const notify = client();
  switch (sent.intent) {
    case "subscribe": {
      const s = sent.subscription;
      if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) return Response.json({ ok: false }, { status: 400 });
      const subscription: PushSubscriptionJson = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
      return Response.json(await notify.subscribe(user, subscription, request.headers.get("user-agent")));
    }
    case "unsubscribe":
      return Response.json(await notify.unsubscribe(user, String(sent.endpoint ?? "")));
    case "preferences":
      return Response.json(await notify.setPreferences(user, sent.preferences ?? {}));
    case "test":
      return Response.json(await notify.test(user));
    case "presence": {
      // Set by hand here: a calendar's or an integration's comes through their own door.
      const change = sent.change ?? {};
      const status = change.status ? { ...change.status, source: "manual" as const } : change.status;
      return Response.json(await notify.setPresence(user, { ...change, ...("status" in change ? { status } : {}) }));
    }
    default:
      return Response.json({ ok: false }, { status: 400 });
  }
}
