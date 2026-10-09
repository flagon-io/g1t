import { env } from "cloudflare:workers";

import { NOTIFY_SEED_HEADER, NOTIFY_VIEWER_HEADER, type FeedSeed, type User } from "@g1t/contracts";

import type { Route } from "./+types/live";
import { chat, inbox } from "../../lib/services.server";
import { roleIn } from "../../lib/session.server";
import { socketViewer } from "../../lib/socket-ticket.server";

/** The longest the counts read for a new socket hold it up. */
const SEED_WAIT_MS = 800;

function within<T>(work: Promise<T>): Promise<T | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SEED_WAIT_MS));
  return Promise.race([work.catch(() => null), timeout]);
}

/**
 * The counts a new socket starts from, read from chat and the inbox now:
 * the feed takes them as the truth for that workspace, then moves them as
 * messages and reads arrive. Whatever is slow is left out, not waited for.
 */
async function seedFor(viewer: User, workspace: string | null): Promise<FeedSeed> {
  const [sidebar, counts] = await Promise.all([
    workspace ? within(chat.sidebar(workspace, viewer)) : Promise.resolve(null),
    within(inbox.counts(viewer.username)),
  ]);
  return {
    workspace,
    per_channel: sidebar?.ok
      ? sidebar.value.entries.map((e) => ({ channel_id: e.channel.id, unread: e.unread, mentions: e.mentions, muted: e.muted }))
      : null,
    inbox_unread: counts ? counts.unread : null,
    // Presence: every workspace whose members see this person (services/notify, src/room.ts).
    workspaces: (viewer.workspaces ?? []).map((membership) => membership.slug.toLowerCase()),
  };
}

/**
 * The signed-in person's feed: `wss://<site>/-/live?workspace=<slug>`, open
 * on every page. The site checks the session and that the page asking is
 * its own, reads the workspace's counts, and hands the upgrade to the
 * notify service, which keeps the socket (one Durable Object per person,
 * hibernating while nothing happens).
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  // A session, or a page opened with a token by its socket ticket.
  const viewer = await socketViewer(context, request);
  if (!viewer) return new Response("Sign in first.", { status: 401 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This address takes a WebSocket.", { status: 426, headers: { upgrade: "websocket" } });
  }
  // Only the site's own pages may open it: a page elsewhere carries the cookie too.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Cross-origin socket refused", { status: 403 });
  if (!env.NOTIFY) return new Response("Notifications are not set up here.", { status: 503 });
  const slug = (new URL(request.url).searchParams.get("workspace") ?? "").toLowerCase();
  const seed = await seedFor(viewer, slug && roleIn(viewer, slug) ? slug : null);
  const headers = new Headers(request.headers);
  // Neither the session nor anything else of the browser's goes on.
  headers.delete("cookie");
  headers.set(NOTIFY_VIEWER_HEADER, JSON.stringify({ id: viewer.id, username: viewer.username }));
  headers.set(NOTIFY_SEED_HEADER, JSON.stringify(seed));
  try {
    return await env.NOTIFY.fetch(new Request("https://notify/live", { method: "GET", headers }));
  } catch (error) {
    console.error("notify: the live socket could not be handed over", error);
    return new Response("Notifications didn't answer.", { status: 503 });
  }
}
