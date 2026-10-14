import { data } from "react-router";

import { type AskPage, type Result, parsePrincipalKey } from "@g1t/contracts";

import type { Route } from "./+types/api";
import { RESERVED_CHANNEL_NAMES, channelName, channelPath } from "../../../lib/chat";
import { principalsFrom } from "../../../lib/chat.server";
import { chat } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

/**
 * What a chat page asks for as it runs, as JSON, without loading a page:
 * the sidebar again, a thread's replies, older messages, the channels to
 * join (`?browse=1`, for the phone app); and everything it
 * sends: messages, read marks, stars, new channels and direct messages,
 * and the actions pressed on cards.
 * Every answer is `{ ok, value }` or `{ ok: false, error }`, the services'
 * own shape.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel");
  const answer = await safely<unknown>(() => {
    // The workspace's own emoji, for the picker and for drawing :name: (components/emoji).
    if (url.searchParams.get("emoji")) return chat.listEmoji(slug, viewer);
    // The channels to find and join, as Browse lists them; for the phone app.
    if (url.searchParams.get("browse")) return chat.browse(slug, viewer, { archived: false });
    if (!channel) return chat.sidebar(slug, viewer);
    return chat.messages(slug, channel, viewer, {
      thread_root: url.searchParams.get("thread"),
      before: url.searchParams.get("before"),
      after: url.searchParams.get("after"),
      limit: Number(url.searchParams.get("limit")) || 60,
    });
  });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

type Sent = {
  intent?: string;
  channel_id?: string;
  body?: string;
  thread_root?: string | null;
  id?: string;
  starred?: boolean;
  muted?: boolean;
  name?: string;
  topic?: string;
  private?: boolean;
  members?: string[];
  member?: string;
  message_id?: string;
  emoji?: string;
  archived?: boolean;
  /** A question for @g1t asked from a page (the top bar's Ask): where they were. */
  page?: unknown;
};

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const sent = (await request.json().catch(() => ({}))) as Sent;
  const channel = sent.channel_id ?? "";
  const answer = await safely(async (): Promise<Result<unknown>> => {
    switch (sent.intent) {
      case "post": {
        const body = (sent.body ?? "").trim();
        if (!body) return { ok: false, error: { code: "invalid", message: "Write something to send." } };
        // The chat service keeps `page` only on a question in a direct message with @g1t, and only what Ask reads of it.
        const page = sent.page && typeof sent.page === "object" ? (sent.page as AskPage) : null;
        return chat.post(slug, channel, viewer, { body, thread_root: sent.thread_root ?? null, page });
      }
      // @g1t: the viewer's direct message with g1t, and what Ask's panel and Chat do in it.
      case "g1t_dm": {
        const opened = await chat.g1tDm(slug, viewer);
        return opened.ok ? { ok: true, value: { channel: opened.value, to: channelPath(slug, opened.value) } } : opened;
      }
      case "g1t_reset":
        return chat.g1tReset(slug, channel, viewer);
      case "g1t_retry":
        return chat.g1tRetry(slug, channel, viewer);
      case "g1t_stop":
        return chat.g1tStop(slug, channel, viewer);
      // Deletes the viewer's own conversation with @g1t for good; the chat service refuses any other.
      case "g1t_clear":
        return chat.g1tClear(slug, channel, viewer);
      case "edit":
        return chat.edit(slug, channel, viewer, sent.id ?? "", (sent.body ?? "").trim());
      case "remove":
        return chat.remove(slug, channel, viewer, sent.id ?? "");
      case "read":
        return chat.markRead(slug, channel, viewer, sent.id ?? "");
      case "react":
        return chat.react(slug, channel, viewer, sent.message_id ?? "", sent.emoji ?? "");
      case "unreact":
        return chat.unreact(slug, channel, viewer, sent.message_id ?? "", sent.emoji ?? "");
      case "preferences":
        return chat.setPreferences(slug, channel, viewer, { starred: sent.starred, muted: sent.muted });
      case "join":
        return chat.join(slug, channel, viewer);
      case "leave":
        return chat.leave(slug, channel, viewer);
      case "invite": {
        const [member] = await principalsFrom(slug, viewer, [sent.member ?? ""]);
        // A person by username, or by the account id chat names them with; only people are added.
        const parsed = parsePrincipalKey(sent.member ?? "");
        const principal = member ?? (parsed?.kind === "user" ? parsed : null);
        if (!principal) return { ok: false, error: { code: "invalid", message: "Choose someone to add." } };
        return chat.invite(slug, channel, viewer, principal);
      }
      case "create_channel": {
        const name = channelName(sent.name ?? "");
        if (!name) return { ok: false, error: { code: "invalid", message: "Give the channel a name." } };
        if ((RESERVED_CHANNEL_NAMES as readonly string[]).includes(name)) {
          return { ok: false, error: { code: "invalid", message: `#${name} is taken by g1t. Try another name.` } };
        }
        const made = await chat.createChannel(slug, viewer, { name, topic: sent.topic?.trim() || null, private: Boolean(sent.private) });
        return made.ok ? { ok: true, value: { channel: made.value, to: channelPath(slug, made.value) } } : made;
      }
      case "update_channel": {
        // A rename, a new topic, archiving or unarchiving; the chat service checks who may.
        const change: { name?: string; topic?: string | null; archived?: boolean } = {};
        if (typeof sent.name === "string") {
          const name = channelName(sent.name);
          if (!name) return { ok: false, error: { code: "invalid", message: "Give the channel a name." } };
          if ((RESERVED_CHANNEL_NAMES as readonly string[]).includes(name)) {
            return { ok: false, error: { code: "invalid", message: `#${name} is taken by g1t. Try another name.` } };
          }
          change.name = name;
        }
        if (typeof sent.topic === "string") change.topic = sent.topic.trim() || null;
        if (typeof sent.archived === "boolean") change.archived = sent.archived;
        const updated = await chat.updateChannel(slug, channel, viewer, change);
        return updated.ok ? { ok: true, value: { channel: updated.value, to: channelPath(slug, updated.value) } } : updated;
      }
      case "dm": {
        const members = await principalsFrom(slug, viewer, sent.members ?? []);
        if (members.length === 0) return { ok: false, error: { code: "invalid", message: "Choose who to message." } };
        const opened = await chat.openDm(slug, viewer, members);
        return opened.ok ? { ok: true, value: { channel: opened.value, to: channelPath(slug, opened.value) } } : opened;
      }
      default:
        return { ok: false, error: { code: "invalid", message: "Unknown request." } };
    }
  });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

/** A service's answer, or a failure that says chat did not answer. */
async function safely<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch (error) {
    console.error("chat: the chat service did not answer", error);
    return { ok: false, error: { code: "conflict", message: "Chat didn't answer. Try again in a moment." } };
  }
}
