/**
 * The notify service: live notifications, unread counts and browser push.
 * One feed per person (src/feed.ts). Plan: docs/WORKSPACE.md, "Live
 * notifications".
 *
 * Reached through service bindings only: `POST /rpc/<method>` with
 * snake_case bodies (`notifyClient` in @g1t/contracts), and `GET /live`,
 * the person's feed socket, which the site forwards after checking the
 * session (NOTIFY_VIEWER_HEADER), with the counts it read (NOTIFY_SEED_HEADER).
 *
 * Who sends what:
 * - chat: `deliver`, for every message (counts for each person in the
 *   conversation, a notification for those it is for) and every read;
 * - events: `notify`, for every inbox item, and `set_inbox`, the count after
 *   items arrive or are marked, naming the person by username;
 * - the site: `subscribe`, `unsubscribe`, `status`, `set_preferences` and
 *   `test`, for the person signed in.
 */
import {
  NOTIFY_VIEWER_HEADER,
  identityClient,
  type FeedDelivery,
  type ServiceBinding,
  type Viewer,
} from "@g1t/contracts";

import { Feed, type FeedEnv } from "./feed.ts";

export { Feed } from "./feed.ts";

type Env = FeedEnv & {
  IDENTITY: ServiceBinding;
  FEEDS: DurableObjectNamespace<Feed>;
};

function feed(env: Env, userId: string) {
  return env.FEEDS.get(env.FEEDS.idFromName(userId));
}

/** A user id from the arguments, or one looked up by username. */
async function userIdOf(env: Env, args: { user_id?: unknown; username?: unknown }): Promise<string | null> {
  if (typeof args.user_id === "string" && args.user_id) return args.user_id;
  if (typeof args.username !== "string" || !args.username) return null;
  const user = await identityClient(env.IDENTITY)
    .userByUsername(args.username)
    .catch(() => null);
  return user?.id ?? null;
}

/** The most deliveries in one call; chat sends one per person in the conversation. */
const MAX_DELIVERIES = 1000;

async function answer(env: Env, method: string, args: any): Promise<Response> {
  if (method === "deliver") {
    const items = (Array.isArray(args?.items) ? args.items : []).slice(0, MAX_DELIVERIES) as FeedDelivery[];
    const byUser = new Map<string, FeedDelivery[]>();
    for (const item of items) {
      if (typeof item?.user_id !== "string" || !item.user_id) continue;
      byUser.set(item.user_id, [...(byUser.get(item.user_id) ?? []), item]);
    }
    const results = await Promise.allSettled([...byUser].map(([id, mine]) => feed(env, id).deliver(mine)));
    for (const result of results) if (result.status === "rejected") console.error("notify: a delivery failed", result.reason);
    return Response.json({ ok: true });
  }
  const userId = await userIdOf(env, args ?? {});
  if (!userId) return Response.json({ ok: false });
  const stub = feed(env, userId);
  switch (method) {
    case "notify":
      return Response.json(await stub.notify(args.notification));
    case "set_inbox":
      return Response.json(await stub.setInbox(Number(args.unread)));
    case "subscribe":
      return Response.json(await stub.subscribe(args.subscription, typeof args.user_agent === "string" ? args.user_agent : null));
    case "unsubscribe":
      return Response.json(await stub.unsubscribe(String(args.endpoint ?? "")));
    case "status":
      return Response.json(await stub.status(typeof args.endpoint === "string" ? args.endpoint : null));
    case "set_preferences":
      return Response.json(await stub.setPreferences(args.preferences));
    case "test":
      return Response.json(await stub.test(typeof args.username === "string" ? args.username : ""));
    default:
      return new Response("Unknown method\n", { status: 404 });
  }
}

/**
 * `GET /live`, upgraded: the viewer comes in NOTIFY_VIEWER_HEADER, set by
 * the site after checking the session; trusted only because this Worker
 * is reachable through service bindings alone.
 */
async function live(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade\n", { status: 426 });
  }
  let viewer: Viewer = null;
  try {
    viewer = JSON.parse(request.headers.get(NOTIFY_VIEWER_HEADER) ?? "null") as Viewer;
  } catch {
    viewer = null;
  }
  if (!viewer?.id) return new Response("Sign in first\n", { status: 401 });
  const headers = new Headers(request.headers);
  headers.delete(NOTIFY_VIEWER_HEADER);
  return feed(env, viewer.id).fetch(new Request(request.url, { method: "GET", headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/live") return live(request, env);
    const match = url.pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (request.method !== "POST" || !match) return new Response("Not found\n", { status: 404 });
    const args = (await request.json().catch(() => ({}))) as any;
    return answer(env, match[1], args);
  },
} satisfies ExportedHandler<Env>;

