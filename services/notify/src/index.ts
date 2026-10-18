/**
 * The notify service: live notifications, unread counts, and push to
 * browsers (Web Push) and to the phone app (through Expo, src/expopush.ts).
 * One feed per person (src/feed.ts).
 *
 * Reached through service bindings only: `POST /rpc/<method>` with
 * snake_case bodies (`notifyClient` in @g1t/contracts), and `GET /live`,
 * the person's feed socket, which the site forwards after checking the
 * session (NOTIFY_VIEWER_HEADER), with the counts it read (NOTIFY_SEED_HEADER).
 *
 * Who sends what:
 * - chat: `deliver`, for every message (counts for each person in the
 *   conversation, a notification for those it is for) and every read;
 *   `forget_conversation`, when someone clears their direct message with
 *   @g1t (src/forget.ts);
 * - events: `notify`, for every inbox item, and `set_inbox`, the count after
 *   items arrive or are marked, naming the person by username;
 * - the site: `subscribe`, `unsubscribe`, `status`, `set_preferences`,
 *   `test`, `presence` and `set_presence`, for the person signed in;
 *   `register_device` and `unregister_device`, for the phone app they
 *   signed in to (through `/-/notify`); and
 *   `last_visit` and `mark_visit`, when they were last on a workspace's
 *   Home page (src/visits.ts);
 * - the site: `workspace_presence`, how a workspace's people
 *   show now (away, in Do Not Disturb, offline, and their statuses);
 * - integrations, later: `set_presence` with a status of `source`
 *   `calendar` or `integration`, for the person they act for;
 * - events and actions: `repo_changed`, what changed in repositories,
 *   told to whoever watches their pages; and the site `watch_repo`, for a
 *   tab on a repository page whose person it checked may read it;
 * - events: `workspace_changed`, what changed to workspaces' work items,
 *   told to whoever watches their Work pages; and the site
 *   `watch_workspace`, for a tab on a Work page whose person it checked is
 *   a member.
 *
 * Presence: each feed works out its person's from their tabs and tells
 * one room per workspace (src/room.ts), which tells everyone there who is
 * online. See docs.g1t.sh/guides/chat/, "Presence and status".
 *
 * Live repository pages: one topic per repository (src/topic.ts) keeps
 * who is watching it, and hands each change to their feeds. See
 * docs.g1t.sh/guides/notifications/, "Pages that update live".
 */
import { NOTIFY_VIEWER_HEADER, identityClient, type FeedDelivery, type ServiceBinding, type Viewer } from "@g1t/contracts";

import { FEED_USERNAME_HEADER, FEED_USER_ID_HEADER, Feed, type FeedEnv } from "./feed.ts";
import { cleanChannelId } from "./forget.ts";
import { onlyPeople } from "./presence.ts";
import { visitWorkspace } from "./visits.ts";
import { settledThreads } from "./prefs.ts";
import { byRepo, byWorkspace, cleanRepoId, cleanRepoPath, cleanWorkspace, workspaceTopic } from "./watch.ts";

export { Feed } from "./feed.ts";
export { Room } from "./room.ts";
export { Topic } from "./topic.ts";

type Env = FeedEnv & {
  IDENTITY: ServiceBinding;
  FEEDS: DurableObjectNamespace<Feed>;
};

function feed(env: Env, userId: string) {
  return env.FEEDS.get(env.FEEDS.idFromName(userId));
}

/** A user id from the arguments, or one looked up by username. */
async function userIdOf(env: Env, given: { user_id?: unknown; username?: unknown; target?: unknown }): Promise<string | null> {
  // Who it's for, at the top level or under `target`.
  const target = given.target && typeof given.target === "object" ? (given.target as { user_id?: unknown; username?: unknown }) : null;
  const args = { user_id: given.user_id ?? target?.user_id, username: given.username ?? target?.username };
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
  if (method === "purge_personal_data") {
    if (typeof args?.id !== "string" || !args.id) return Response.json({ ok: false }, { status: 400 });
    if (args.kind === "user") return Response.json(await feed(env, args.id).erase(args.id));
    if (args.kind !== "workspace" || typeof args.slug !== "string" || !args.slug) return Response.json({ ok: false }, { status: 400 });
    // Every slug it went by, and everyone identity knew as a member when it
    // was purged, besides those its presence rooms know: their feeds keep
    // notifications, counts and visits under the slug.
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : []);
    const slugs = [...new Set([args.slug, ...strings(args.old_slugs)].map((slug) => slug.toLowerCase()))];
    const members = strings(args.members);
    for (const slug of slugs) {
      const room = env.ROOMS?.get(env.ROOMS.idFromName(slug));
      const people = room ? await room.eraseMembers() : [];
      const everyone = [...new Set([...people, ...members])];
      for (let i = 0; i < everyone.length; i += 20) {
        await Promise.all(everyone.slice(i, i + 20).map((userId) => feed(env, userId).eraseWorkspace(slug)));
      }
      // Only once their feeds are cleared, so a failure leaves them listed for the retry.
      if (room) for (const userId of people) await room.dropPerson(userId);
    }
    return Response.json({ ok: true });
  }
  if (method === "workspace_presence") {
    // For services: how a workspace's people show now, as its room keeps them.
    const slug = typeof args?.workspace === "string" ? args.workspace.trim().toLowerCase() : "";
    if (!slug || !env.ROOMS) return Response.json([]);
    const everyone = await env.ROOMS.get(env.ROOMS.idFromName(slug)).people();
    return Response.json(onlyPeople(everyone, Array.isArray(args.user_ids) ? args.user_ids : null));
  }
  if (method === "repo_changed") {
    // For services: each repository's changes to its topic, which tells its watchers.
    const topics = env.TOPICS;
    if (!topics) return Response.json({ ok: true });
    const grouped = byRepo(args?.changes);
    const results = await Promise.allSettled([...grouped].map(([id, changes]) => topics.get(topics.idFromName(id)).changed(id, changes)));
    for (const result of results) if (result.status === "rejected") console.error("notify: a repository's change was not told", result.reason);
    return Response.json({ ok: true });
  }
  if (method === "workspace_changed") {
    // For services: each workspace's work item changes to its topic, which tells whoever watches its Work pages.
    const topics = env.TOPICS;
    if (!topics) return Response.json({ ok: true });
    const grouped = byWorkspace(args?.changes);
    const results = await Promise.allSettled(
      [...grouped].map(([slug, changes]) => {
        const key = workspaceTopic(slug);
        return topics.get(topics.idFromName(key)).workspaceChanged(key, changes);
      }),
    );
    for (const result of results) if (result.status === "rejected") console.error("notify: a workspace's change was not told", result.reason);
    return Response.json({ ok: true });
  }
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
      return Response.json(await stub.setInbox(Number(args.unread), settledThreads(args.settled)));
    case "subscribe":
      return Response.json(await stub.subscribe(args.subscription, typeof args.user_agent === "string" ? args.user_agent : null));
    case "unsubscribe":
      return Response.json(await stub.unsubscribe(String(args.endpoint ?? "")));
    case "register_device":
      return Response.json(await stub.registerDevice(args.device));
    case "unregister_device":
      return Response.json(await stub.unregisterDevice(String(args.token ?? "")));
    case "status":
      return Response.json(await stub.status(typeof args.endpoint === "string" ? args.endpoint : null));
    case "set_preferences":
      return Response.json(await stub.setPreferences(args.preferences));
    case "last_visit":
    case "mark_visit": {
      const workspace = visitWorkspace(args.workspace);
      if (!workspace) return Response.json({ seen_at: null });
      return Response.json(method === "last_visit" ? await stub.lastVisit(workspace) : await stub.markVisit(workspace, args.at));
    }
    case "watch_repo": {
      const repoId = cleanRepoId(args.repo_id);
      const repo = cleanRepoPath(args.repo);
      if (!repoId || !repo) return Response.json({ ok: false, until: null });
      return Response.json(await stub.watchRepo(userId, repoId, repo));
    }
    case "watch_workspace": {
      // The site checked the person is a member: members see all of its work items.
      const workspace = cleanWorkspace(args.workspace);
      if (!workspace) return Response.json({ ok: false, until: null });
      return Response.json(await stub.watchWorkspace(userId, workspace));
    }
    case "forget_conversation": {
      // For chat, after the person cleared their direct message with @g1t (src/forget.ts).
      const channelId = cleanChannelId(args.channel_id);
      const workspace = visitWorkspace(args.workspace);
      if (!channelId || !workspace) return Response.json({ ok: false });
      return Response.json(await stub.forgetConversation(workspace, channelId));
    }
    case "test":
      return Response.json(await stub.test(typeof args.username === "string" ? args.username : ""));
    case "presence":
      return Response.json(await stub.own({ user_id: userId, username: typeof args.username === "string" ? args.username : "" }));
    case "set_presence":
      return Response.json(await stub.setPresence({ user_id: userId, username: typeof args.username === "string" ? args.username : "" }, args.change ?? {}));
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
  // Who the feed is for, so it can name them to the presence rooms.
  headers.set(FEED_USER_ID_HEADER, viewer.id);
  headers.set(FEED_USERNAME_HEADER, viewer.username);
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
