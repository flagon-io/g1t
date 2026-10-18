import { env } from "cloudflare:workers";
import { data } from "react-router";

import { notifyClient, type NotifyPreferencesChange, type PresenceChange, type PushDevice, type PushSubscriptionJson } from "@g1t/contracts";
import type { SoundSettingsChange } from "@g1t/contracts/sounds";

import type { Route } from "./+types/api";
import { repoFor } from "../../lib/access.server";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../lib/session.server";

function client() {
  if (!env.NOTIFY) throw data({ error: "Notifications are not set up here." }, { status: 503 });
  return notifyClient(env.NOTIFY);
}

/**
 * The signed-in person's notification settings, as JSON: `GET` their
 * status (with `?endpoint=` for whether this browser gets pushes, and how
 * many phones do), `POST` a change: `subscribe`, `unsubscribe`,
 * `register_device` and `unregister_device` (the phone app, with its Expo
 * push token), `preferences`, `test`, `presence` (your status, being away,
 * Do Not Disturb), `sounds` (what you hear when chat moves, kept with
 * the account by identity), or `watch_repo`, for a repository page that
 * updates live: its tabs then hear what changes there (`repo`, its
 * `owner/name`), once the person is found to be able to read it
 * (lib/repo-live.ts); `watch_repos` the same for several at once (`repos`,
 * at most WATCH_REPOS_MAX: Home watches its workspace's); `watch_workspace`
 * for a workspace's Work pages (`workspace`, its slug): its members' tabs
 * then hear what changes to its work items.
 *
 * The phone app calls this with its access token and no `Origin`, which
 * the same-origin check lets through (lib/same-origin.ts).
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
  device?: PushDevice;
  token?: string;
  preferences?: NotifyPreferencesChange;
  change?: PresenceChange | SoundSettingsChange;
  repo?: string;
  repos?: unknown;
  workspace?: string;
};

/** The most repositories one `watch_repos` asks for (notify keeps 50 per person). */
const WATCH_REPOS_MAX = 25;

/** Watches `path` (`owner/name`) for `user` when they can read it; the repository's id, or null. */
async function watchOne(context: Route.ActionArgs["context"], notify: ReturnType<typeof client>, user: ReturnType<typeof requireUser>, path: string) {
  // Only a repository they can read: the same lookup its pages make.
  const [owner, name, ...rest] = path.split("/");
  if (!owner || !name || rest.length) return null;
  const found = await repoFor(context, { owner, repo: name });
  if (!found.ok) return null;
  const repo = found.value;
  const watched = await notify.watchRepo(user, repo.id, `${repo.namespace}/${repo.name}`);
  return { ...watched, repo_id: repo.id };
}

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
    case "register_device": {
      const d = sent.device;
      if (typeof d?.token !== "string" || (d.platform !== "android" && d.platform !== "ios")) return Response.json({ ok: false }, { status: 400 });
      const device: PushDevice = { token: d.token, platform: d.platform, name: typeof d.name === "string" ? d.name : null };
      const registered = await notify.registerDevice(user, device);
      // The service checks the token is Expo's; `off` is this g1t sending phones nothing (PHONE_PUSH=off), not a mistake.
      return Response.json(registered, { status: registered.ok || registered.off ? 200 : 400 });
    }
    case "unregister_device":
      return Response.json(await notify.unregisterDevice(user, String(sent.token ?? "")));
    case "preferences":
      return Response.json(await notify.setPreferences(user, sent.preferences ?? {}));
    case "test":
      return Response.json(await notify.test(user));
    case "sounds": {
      const saved = await identity.setSoundSettings(user, (sent.change ?? {}) as SoundSettingsChange);
      if (!saved.ok) return Response.json({ ok: false, error: saved.error.message }, { status: 400 });
      return Response.json(saved.value);
    }
    case "presence": {
      // Set by hand here: a calendar's or an integration's comes through their own door.
      const change = (sent.change ?? {}) as PresenceChange;
      const status = change.status ? { ...change.status, source: "manual" as const } : change.status;
      return Response.json(await notify.setPresence(user, { ...change, ...("status" in change ? { status } : {}) }));
    }
    case "watch_repo": {
      const path = String(sent.repo ?? "");
      if (path.split("/").length !== 2) return Response.json({ ok: false }, { status: 400 });
      const watched = await watchOne(context, notify, user, path);
      return watched ? Response.json(watched) : Response.json({ ok: false }, { status: 404 });
    }
    case "watch_repos": {
      const paths = Array.isArray(sent.repos) ? [...new Set(sent.repos.filter((path): path is string => typeof path === "string"))] : [];
      if (paths.length === 0 || paths.length > WATCH_REPOS_MAX) return Response.json({ ok: false }, { status: 400 });
      const watched = (await Promise.all(paths.map((path) => watchOne(context, notify, user, path).catch(() => null)))).filter((one) => one?.ok);
      return Response.json({ ok: watched.length > 0, repo_ids: watched.map((one) => one!.repo_id) });
    }
    case "watch_workspace": {
      const slug = String(sent.workspace ?? "").toLowerCase();
      if (!slug) return Response.json({ ok: false }, { status: 400 });
      // Only a workspace they belong to: what changes to its work items is its members'.
      if (roleIn(user, slug) == null) return Response.json({ ok: false }, { status: 404 });
      return Response.json(await notify.watchWorkspace(user, slug));
    }
    default:
      return Response.json({ ok: false }, { status: 400 });
  }
}
