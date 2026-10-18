import { purgePersonalData } from "./erasure.ts";
/**
 * The chat service: a workspace's channels, direct messages, threads and
 * messages. Conversations are between people (docs.g1t.sh/guides/chat/);
 * messages from agents of the past still show, under the name they had.
 *
 * Reached through service bindings: `POST /rpc/<method>` with snake_case
 * bodies (`chatClient` in @g1t/contracts), and `GET /live` for a channel's
 * socket, which the site forwards after checking the session. Each channel
 * has a room (src/room.ts) that delivers what happens in it live.
 *
 * Workspaces are kept by id, so renaming one changes nothing here; who is
 * in a workspace comes from the viewer's memberships, as in every service.
 */

import {
  CHAT_VIEWER_HEADER,
  G1T_KEY,
  G1T_PRINCIPAL,
  fail,
  identityClient,
  idFloor,
  newId,
  ok,
  openD1,
  parsePrincipalKey,
  principalKey,
  type Channel,
  type ChannelAccessRequest,
  type ChannelChange,
  type ChannelInvitation,
  type ChannelDetail,
  type ChannelMember,
  type ChatLiveEvent,
  type ChatMessage,
  type ChatReaction,
  type CustomEmoji,
  type EmojiFile,
  type EmojiList,
  type EmojiUpload,
  type ChatSettings,
  type ChatSettingsView,
  type ChatActivity,
  type ChatSidebar,
  type ChatSidebarEntry,
  type ChatWorkspace,
  type GuestChannel,
  type Member,
  type MemberProfile,
  type MessageCard,
  type MessagePage,
  type NewChannel,
  type PostMessage,
  type Principal,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
  type Workspace,
} from "@g1t/contracts";

import { type ActivityRow, activitySpan, chatActivity } from "./activity.ts";
// Who may open a conversation, and who is a guest (src/access.ts).
import { type Standing, mayAdmit, mayInviteGuests, mayJoin, mayRead, mayVisit, requestNote, visibilityOf } from "./access.ts";
import {
  MAX_REACTIONS_PER_MESSAGE,
  emojiImage,
  emojiName,
  fromBase64,
  mayRemove,
  mayUpload,
  reactionEmoji,
  roomForReaction,
  tallyReactions,
  type ReactionRow,
  type ReactionTally,
} from "./emoji.ts";
import { shownCard } from "./cards.ts";
// @g1t: the direct message every member has with g1t (src/g1t.ts, src/answer.ts).
import {
  G1T_PROFILE,
  type MessageMeta,
  type ProposalState,
  type SaidRow,
  conversation,
  g1tDmPerson,
  latestPage,
  latestQuestion,
  metaColumn,
  pageFrom,
  parseMeta,
  shownAnswer,
  startsAnswer,
  withProposalState,
} from "./g1t.ts";
import { clearConversation, mayClear } from "./clear.ts";
import { internalAnswer } from "./internal.ts";
import { mentionedHandles, mentionsColumn } from "./mentions.ts";
import { messageBody, meterDay, pageOf, pageSize } from "./messages.ts";
import { GENERAL, MAX_DM_MEMBERS, channelName, dmKey, dmMembers } from "./names.ts";
import { ROOM_MEMBER_HEADER, type ChannelRoom, type RoomMember } from "./room.ts";
import { mayCreateChannel, mayManageChannel, permissionsFor, rowFor, settingsChange, settingsOf, type SettingsRow } from "./settings.ts";
import { dmTitle, sidebarOrder, tally, type UnreadRow } from "./unread.ts";
// Live notifications and counts (services/notify).
import { notifyCleared, notifyMessage, notifyMuted, notifyRead } from "./notify.ts";

export { ChannelRoom } from "./room.ts";

type Env = {
  DB: D1Database;
  IDENTITY: ServiceBinding;
  ROOMS: DurableObjectNamespace<ChannelRoom>;
  /** The avatars namespace: custom emoji images, under `emoji/<sha256>`, which the usercontent origin serves. */
  AVATARS: KVNamespace;
  /** Live notifications and unread counts (services/notify); absent, nobody is told. */
  NOTIFY?: ServiceBinding;
  /** Ask (services/integrations): @g1t's answers, which the channel's room asks for. */
  INTEGRATIONS?: ServiceBinding;
};

type EmojiRow = {
  workspace_id: string;
  name: string;
  alias_of: string | null;
  file: string;
  content_type: CustomEmoji["content_type"];
  bytes: number;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
};

/** The viewer's role in a workspace, or null when they are not in it. */
function roleOf(viewer: Viewer, workspace: string): "owner" | "member" | null {
  return viewer?.workspaces?.find((m) => m.slug === workspace.toLowerCase())?.role ?? null;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ChannelRow = {
  id: string;
  workspace_id: string;
  kind: "channel" | "dm";
  name: string | null;
  topic: string | null;
  private: number;
  /** Open to anyone signed in to g1t (migration 0007). */
  public: number;
  dm_key: string | null;
  created_by: string;
  created_at: string;
  archived_at: string | null;
  last_message_at: string | null;
};

type MemberRow = {
  channel_id: string;
  principal: string;
  role: "owner" | "member";
  starred: number;
  muted: number;
  last_read_id: string | null;
  joined_at: string;
};

type MessageRow = {
  id: string;
  channel_id: string;
  author: string;
  kind: "text" | "card";
  body: string;
  card: string | null;
  mentions: string;
  thread_root: string | null;
  reply_count: number;
  last_reply_at: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  /** On @g1t's answers, questions asked from a page and new-conversation marks (src/g1t.ts `MessageMeta`). */
  meta: string | null;
};

/**
 * An agent deleted for good, as `former_agents` keeps it (migration 0004).
 * Workspaces no longer have agents; their old messages show under the name
 * kept here, else as a deleted agent.
 */
type FormerAgentRow = {
  agent_id: string;
  workspace_id: string;
  handle: string;
  display_name: string;
  avatar_seed: string | null;
  look: string | null;
  deleted_at: string;
};

/** What a method found out about the channel it was asked about; `role` null for a guest. */
type Place = { slug: string; workspace: Workspace; channel: ChannelRow; member: MemberRow | null; role: Standing };

type InvitationRow = { id: string; channel_id: string; workspace_id: string; invitee: string; invited_by: string; created_at: string };
type RequestRow = { id: string; channel_id: string; workspace_id: string; requester: string; note: string | null; created_at: string };

/** The most unread messages one sidebar reads to count; past it, counts are "at least". */
const MAX_UNREAD_ROWS = 5_000;
/** The longest channel topic. */
const MAX_TOPIC = 250;
/** How many others a direct message's sidebar entry shows. */
const DM_FACES = 4;

const now = () => new Date().toISOString();

function isMember(viewer: Viewer, workspace: string): boolean {
  return !!viewer?.workspaces?.some((m) => m.slug === workspace.toLowerCase());
}

function isOwner(viewer: Viewer, workspace: string): boolean {
  return !!viewer?.workspaces?.some((m) => m.slug === workspace.toLowerCase() && m.role === "owner");
}

function userKey(viewer: User): string {
  return principalKey({ kind: "user", id: viewer.id });
}

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    kind: row.kind,
    name: row.kind === "dm" ? null : row.name,
    topic: row.topic,
    private: row.kind === "dm" || !!row.private,
    visibility: visibilityOf(row),
    created_by: parsePrincipalKey(row.created_by) ?? { kind: "user", id: row.created_by },
    created_at: row.created_at,
    archived_at: row.archived_at,
    last_message_at: row.last_message_at,
  };
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

class Chat {
  private readonly workspaces = new Map<string, Promise<Workspace | null>>();
  private readonly people = new Map<string, Promise<Map<string, Member>>>();
  private readonly usernames = new Map<string, string>();
  /** Agents deleted for good, by id, from `former_agents`; null for one chat never heard of. */
  private readonly former = new Map<string, FormerAgentRow | null>();
  private readonly settingsRows = new Map<string, Promise<SettingsRow | null>>();
  /** Guests' accounts by id, for their avatars; null for an id with none. */
  private readonly accountRows = new Map<string, { avatar: string | null } | null>();

  /** `defer` runs work after the answer is sent: the request's waitUntil. */
  constructor(
    private readonly env: Env,
    private readonly defer: (work: Promise<unknown>) => void = () => {},
  ) {}

  private get db() {
    return this.env.DB;
  }

  // ── Who and where ───────────────────────────────────────────────────────

  private workspace(slug: string): Promise<Workspace | null> {
    const key = slug.toLowerCase();
    let found = this.workspaces.get(key);
    if (!found) {
      found = identityClient(this.env.IDENTITY).getWorkspace(key);
      this.workspaces.set(key, found);
    }
    return found;
  }

  /** The workspace's people by username, with their names and avatars; asked once per request. */
  private members(slug: string, workspace: Workspace): Promise<Map<string, Member>> {
    let found = this.people.get(workspace.id);
    if (!found) {
      // Asked as the workspace itself.
      const actor: User = {
        id: workspace.id,
        username: workspace.slug,
        kind: "workspace",
        verified: true,
        workspaces: [{ slug: workspace.slug, role: "member" }],
      };
      found = identityClient(this.env.IDENTITY)
        .listMembers(slug, actor)
        .then((result) => new Map(result.ok ? result.value.map((m) => [m.username, m]) : []))
        .catch((error) => {
          console.error("chat could not list members of", slug, error);
          return new Map<string, Member>();
        });
      this.people.set(workspace.id, found);
    }
    return found;
  }

  /**
   * Agents of the past, by id, as `former_agents` remembers them: the
   * name and face their messages still show under. Once per request.
   */
  private async formerAgents(ids: string[]): Promise<Map<string, FormerAgentRow>> {
    const wanted = [...new Set(ids)].filter((id) => !this.former.has(id));
    if (wanted.length) {
      const rows = await this.db
        .prepare(`SELECT * FROM former_agents WHERE agent_id IN (${wanted.map(() => "?").join(", ")})`)
        .bind(...wanted)
        .all<FormerAgentRow>()
        .catch((error: unknown) => {
          console.error("chat could not read former agents", error);
          return { results: [] as FormerAgentRow[] };
        });
      for (const id of wanted) this.former.set(id, rows.results.find((row) => row.agent_id === id) ?? null);
    }
    const out = new Map<string, FormerAgentRow>();
    for (const id of ids) {
      const row = this.former.get(id);
      if (row) out.set(id, row);
    }
    return out;
  }

  /**
   * How each member key shows, for one workspace. An agent of the past
   * shows under the name it had, else as a deleted agent, marked `deleted`.
   */
  private async profiles(slug: string, workspace: Workspace, keys: string[]): Promise<Map<string, MemberProfile>> {
    const principals = [...new Set(keys)].map((key) => parsePrincipalKey(key)).filter((p): p is Principal => !!p);
    const userIds = principals.filter((p) => p.kind === "user").map((p) => p.id);
    const agentIds = principals.filter((p) => p.kind === "agent").map((p) => p.id);
    const unnamed = userIds.filter((id) => !this.usernames.has(id));
    const [named, people, former] = await Promise.all([
      unnamed.length
        ? identityClient(this.env.IDENTITY)
            .usernames(unnamed)
            .catch(() => ({}) as Record<string, string>)
        : ({} as Record<string, string>),
      userIds.length ? this.members(slug, workspace) : new Map<string, Member>(),
      agentIds.length ? this.formerAgents(agentIds) : new Map<string, FormerAgentRow>(),
    ]);
    for (const [id, username] of Object.entries(named)) this.usernames.set(id, username);
    // People not in the workspace: guests, named and pictured from their accounts.
    // Only when the members were read, so a failed read marks no one.
    const outside = people.size
      ? userIds.filter((id) => {
          const username = this.usernames.get(id);
          return !!username && !people.has(username);
        })
      : [];
    const accounts = await this.accounts(outside);
    const out = new Map<string, MemberProfile>();
    for (const p of principals) {
      if (p.kind === "system") {
        // @g1t: the one system member there is.
        out.set(principalKey(p), G1T_PROFILE);
      } else if (p.kind === "user") {
        const username = this.usernames.get(p.id) ?? null;
        const person = username ? people.get(username) : undefined;
        const guest = outside.includes(p.id);
        out.set(principalKey(p), {
          ...p,
          name: username ?? "ghost",
          display_username: person?.display_username ?? null,
          // Their display name, else their username as they wrote it
          // (`memberName` reads this the same way).
          display_name: person?.name?.trim() || person?.display_username || username || "Former member",
          avatar: person?.avatar ?? accounts.get(p.id)?.avatar ?? null,
          role: null,
          title: null,
          avatar_seed: null,
          ...(guest ? { guest: true } : {}),
        });
      } else {
        const was = former.get(p.id) ?? null;
        out.set(principalKey(p), {
          ...p,
          name: was?.handle ?? p.id,
          // Never blank: an old agent's messages show under the name it had, else as a deleted agent.
          display_name: was?.display_name ?? "A deleted agent",
          avatar: null,
          role: null,
          title: null,
          avatar_seed: was?.avatar_seed ?? null,
          archived_at: null,
          archived_by: null,
          deleted: true,
        });
      }
    }
    return out;
  }

  /** Accounts of people outside the workspace, for their avatars; asked once per request. */
  private async accounts(ids: string[]): Promise<Map<string, { avatar: string | null }>> {
    const wanted = ids.filter((id) => !this.accountRows.has(id));
    if (wanted.length) {
      const found = await identityClient(this.env.IDENTITY)
        .accounts(wanted.slice(0, 200))
        .catch((error: unknown) => {
          console.error("chat could not read accounts", error);
          return {} as Record<string, { avatar: string | null }>;
        });
      for (const id of wanted) this.accountRows.set(id, found[id] ? { avatar: found[id].avatar ?? null } : null);
    }
    const out = new Map<string, { avatar: string | null }>();
    for (const id of ids) {
      const row = this.accountRows.get(id);
      if (row) out.set(id, row);
    }
    return out;
  }

  /** A workspace as chat names it to someone who may not be in it. */
  private chatWorkspace(workspace: Workspace): ChatWorkspace {
    return { slug: workspace.slug.toLowerCase(), name: workspace.name, avatar: workspace.avatar };
  }

  private async profile(slug: string, workspace: Workspace, key: string): Promise<MemberProfile> {
    return (await this.profiles(slug, workspace, [key])).get(key)!;
  }

  /** Whether `principal` may be added to a conversation in this workspace: people of it only. */
  private async belongs(slug: string, workspace: Workspace, principal: Principal): Promise<boolean> {
    if (principal.kind !== "user") return false;
    if (!this.usernames.has(principal.id)) {
      const named = await identityClient(this.env.IDENTITY).usernames([principal.id]);
      for (const [id, username] of Object.entries(named)) this.usernames.set(id, username);
    }
    const username = this.usernames.get(principal.id);
    return !!username && (await this.members(slug, workspace)).has(username);
  }

  /**
   * The viewer's workspace, checked: they must belong to it, as in every
   * other service.
   */
  private async viewerWorkspace(slug: string, viewer: Viewer): Promise<Result<Workspace>> {
    if (!viewer) return fail("unauthenticated", "Sign in to use chat.");
    if (!slug || !isMember(viewer, slug)) return fail("forbidden", "Only members of a workspace can use its chat.");
    const workspace = await this.workspace(slug);
    return workspace ? ok(workspace) : fail("not_found", "No such workspace.");
  }

  /**
   * The workspace for someone who may be a guest in it: anyone signed in
   * who may visit other workspaces' chat (src/access.ts `mayVisit`), with
   * their role there, null when they are not a member.
   */
  private async visitWorkspace(slug: string, viewer: Viewer): Promise<Result<{ workspace: Workspace; role: Standing }>> {
    const role = slug ? roleOf(viewer, slug) : null;
    if (!role) {
      const refused = mayVisit(viewer);
      if (refused) return fail(viewer ? "forbidden" : "unauthenticated", refused);
    }
    const workspace = slug ? await this.workspace(slug) : null;
    return workspace ? ok({ workspace, role }) : fail("not_found", "No such workspace.");
  }

  /**
   * A channel the viewer may read (`read`: one they are in, or one whose
   * visibility lets them: kept to the workspace for its members, public
   * for anyone) or write in (`member`: one they are in). One they may not
   * read is not found, so its existence does not leak.
   */
  private async place(slug: string, channelId: string, viewer: Viewer, need: "read" | "member"): Promise<Result<Place>> {
    const found = await this.visitWorkspace(slug, viewer);
    if (!found.ok) return found;
    const { workspace, role } = found.value;
    const [channel, member] = await Promise.all([
      this.db
        .prepare("SELECT * FROM channels WHERE id = ? AND workspace_id = ?")
        .bind(String(channelId ?? ""), workspace.id)
        .first<ChannelRow>(),
      this.db
        .prepare("SELECT * FROM channel_members WHERE channel_id = ? AND principal = ?")
        .bind(String(channelId ?? ""), userKey(viewer!))
        .first<MemberRow>(),
    ]);
    if (!channel) return fail("not_found", "No such channel.");
    // A guest is never in a direct message (`openDm` is for members), so none is ever theirs.
    if (!role && channel.kind === "dm") return fail("not_found", "No such channel.");
    if (!mayRead(visibilityOf(channel), role, !!member)) return fail("not_found", "No such channel.");
    if (!member && need === "member") return fail("forbidden", `Join #${channel.name} first.`);
    return ok({ slug: slug.toLowerCase(), workspace, channel, member, role });
  }

  /** Whether `key` (`user:<id>`) was taken out of this channel by its owners. */
  private async removed(channelId: string, key: string): Promise<boolean> {
    return !!(await this.db.prepare("SELECT 1 FROM channel_removals WHERE channel_id = ? AND principal = ?").bind(channelId, key).first());
  }

  private room(channelId: string) {
    return this.env.ROOMS.get(this.env.ROOMS.idFromName(channelId));
  }

  /** Tells everyone looking at a channel, after the answer is sent. */
  private broadcast(channelId: string, event: ChatLiveEvent, except: string | null = null): void {
    this.defer(
      this.room(channelId)
        .broadcast(event, except)
        .catch((error: unknown) => console.error("chat could not broadcast to", channelId, error)),
    );
  }

  /**
   * Messages as they go out, with their reactions. `me` (a member key) is
   * the viewer an answer is for; null for what everyone in a room gets,
   * where no reaction is anyone's own.
   */
  private async toMessages(slug: string, workspace: Workspace, rows: MessageRow[], me: string | null = null): Promise<ChatMessage[]> {
    const reactions = await this.reactionsOf(
      rows.filter((r) => !r.deleted_at).map((r) => r.id),
      me,
    );
    const reactors = [...reactions.values()].flatMap((list) => list.flatMap((r) => r.by));
    const profiles = await this.profiles(slug, workspace, [...rows.map((r) => r.author), ...reactors]);
    const at = Date.now();
    return rows.map((row) => {
      const gone = !!row.deleted_at;
      // @g1t's answers, questions asked from a page, new-conversation marks (src/g1t.ts).
      const meta = gone ? {} : parseMeta(row.meta);
      const extra: Pick<ChatMessage, "answer" | "page" | "reset"> = {};
      if (meta.answer) extra.answer = shownAnswer(meta.answer, row.created_at, at);
      if (meta.page) extra.page = meta.page;
      if (meta.reset) extra.reset = true;
      return {
        ...extra,
        reactions: gone ? [] : (reactions.get(row.id) ?? []).map((r) => ({ ...r, by: r.by.map((key) => profiles.get(key)!).filter(Boolean) })),
        id: row.id,
        channel_id: row.channel_id,
        author: profiles.get(row.author)!,
        kind: row.kind,
        body: gone ? "" : row.body,
        card: gone || !row.card ? null : shownCard(JSON.parse(row.card) as MessageCard),
        thread_root: row.thread_root,
        reply_count: row.reply_count,
        last_reply_at: row.last_reply_at,
        created_at: row.created_at,
        edited_at: row.edited_at,
        deleted_at: row.deleted_at,
      };
    });
  }

  /** Reactions on these messages, counted (src/emoji.ts). One read, by the reactions table's key. */
  private async reactionsOf(ids: string[], me: string | null): Promise<Map<string, ReactionTally[]>> {
    if (!ids.length) return new Map();
    const rows = await this.db
      .prepare("SELECT message_id, emoji, principal, created_at FROM reactions WHERE message_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ids))
      .all<ReactionRow>();
    return tallyReactions(rows.results, me);
  }

  private async messageRow(channelId: string, id: string): Promise<MessageRow | null> {
    return this.db
      .prepare("SELECT * FROM messages WHERE id = ? AND channel_id = ?")
      .bind(String(id ?? ""), channelId)
      .first<MessageRow>();
  }

  /** Sends a message as it now is to everyone looking at its channel. */
  private rebroadcast(place: Place, id: string): void {
    this.defer(
      (async () => {
        const row = await this.messageRow(place.channel.id, id);
        if (!row) return;
        const [message] = await this.toMessages(place.slug, place.workspace, [row]);
        await this.room(place.channel.id).broadcast({ type: "message.updated", message });
      })().catch((error) => console.error("chat could not rebroadcast", id, error)),
    );
  }

  // ── The sidebar ─────────────────────────────────────────────────────────

  /**
   * Puts a person in the workspace's #general, once. A new workspace has
   * no channels, so the first sidebar anyone in it asks for creates
   * #general; and everyone who asks for the sidebar is put in it the first
   * time, so a new workspace has somewhere to talk and a new member lands
   * where everyone is. Someone who leaves it is not put back
   * (`general_joined`). A private channel someone named `general` is never
   * joined this way.
   */
  private async ensureGeneral(workspace: Workspace, me: string): Promise<void> {
    const seen = await this.db.prepare("SELECT 1 FROM general_joined WHERE workspace_id = ? AND principal = ?").bind(workspace.id, me).first();
    if (seen) return;
    const at = now();
    await this.db
      .prepare("INSERT OR IGNORE INTO channels (id, workspace_id, kind, name, topic, private, created_by, created_at) VALUES (?, ?, 'channel', ?, ?, 0, ?, ?)")
      .bind(newId("chn"), workspace.id, GENERAL, "Anything and everything for the whole workspace.", me, at)
      .run();
    const general = await this.db.prepare("SELECT * FROM channels WHERE workspace_id = ? AND name = ?").bind(workspace.id, GENERAL).first<ChannelRow>();
    const statements = [
      this.db.prepare("INSERT OR IGNORE INTO general_joined (workspace_id, principal, joined_at) VALUES (?, ?, ?)").bind(workspace.id, me, at),
    ];
    // The workspace's default channels (#general unless its owners chose
    // others): public and not archived only, whatever was kept.
    const settings = await this.settings(workspace, general?.id ?? null);
    const defaults = settings.default_channels.length
      ? await this.db
          .prepare(
            "SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND private = 0 AND archived_at IS NULL AND id IN (SELECT value FROM json_each(?))",
          )
          .bind(workspace.id, JSON.stringify(settings.default_channels))
          .all<ChannelRow>()
      : { results: [] as ChannelRow[] };
    for (const channel of defaults.results) {
      statements.push(this.joinStatement(channel.id, me, channel.created_by === me ? "owner" : "member", at));
    }
    await this.db.batch(statements);
  }

  /**
   * Adds a member. Someone joining starts with everything already said
   * read, so a long channel does not greet them with its whole history as
   * unread.
   */
  private joinStatement(channelId: string, principal: string, role: "owner" | "member", at: string): D1PreparedStatement {
    return this.db
      .prepare(
        "INSERT OR IGNORE INTO channel_members (channel_id, principal, role, last_read_id, joined_at) VALUES (?1, ?2, ?3, (SELECT MAX(id) FROM messages WHERE channel_id = ?1), ?4)",
      )
      .bind(channelId, principal, role, at);
  }

  /**
   * The sidebar. A member's lists every conversation they are in; a
   * guest's, only the channels of this workspace they are in, with the
   * public ones they have not joined counted. Both carry the channels of
   * other workspaces the viewer is a guest in, and their invitations.
   */
  async sidebar(a: { workspace: string; viewer: Viewer }): Promise<Result<ChatSidebar>> {
    const found = await this.visitWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const { workspace, role } = found.value;
    const slug = a.workspace.toLowerCase();
    const me = userKey(a.viewer!);
    // #general is for the workspace's own people.
    if (role) await this.ensureGeneral(workspace, me);

    const [joined, unread, dmOthers, browsable, elsewhere, invitations] = await Promise.all([
      this.db
        .prepare(
          `SELECT c.*, m.starred, m.muted, m.last_read_id
           FROM channel_members m JOIN channels c ON c.id = m.channel_id
           WHERE m.principal = ? AND c.workspace_id = ? AND c.archived_at IS NULL`,
        )
        .bind(me, workspace.id)
        .all<ChannelRow & { starred: number; muted: number; last_read_id: string | null }>(),
      this.db
        .prepare(
          `SELECT msg.channel_id, msg.id, msg.author, msg.mentions
           FROM channel_members m
           JOIN channels c ON c.id = m.channel_id
           JOIN messages msg ON msg.channel_id = m.channel_id AND msg.id > COALESCE(m.last_read_id, '')
           WHERE m.principal = ?1 AND c.workspace_id = ?2 AND c.archived_at IS NULL
             AND msg.deleted_at IS NULL AND msg.author != ?1
           LIMIT ${MAX_UNREAD_ROWS}`,
        )
        .bind(me, workspace.id)
        .all<UnreadRow>(),
      this.db
        .prepare(
          `SELECT o.channel_id, o.principal
           FROM channel_members m
           JOIN channels c ON c.id = m.channel_id AND c.kind = 'dm'
           JOIN channel_members o ON o.channel_id = m.channel_id AND o.principal != m.principal
           WHERE m.principal = ? AND c.workspace_id = ? AND c.archived_at IS NULL
           ORDER BY o.joined_at, o.principal`,
        )
        .bind(me, workspace.id)
        .all<{ channel_id: string; principal: string }>(),
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM channels c
           WHERE c.workspace_id = ? AND c.kind = 'channel' AND c.private = 0 AND c.archived_at IS NULL
             AND (? = 1 OR c.public = 1)
             AND NOT EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.principal = ?)`,
        )
        .bind(workspace.id, role ? 1 : 0, me)
        .first<{ n: number }>(),
      this.elsewhere(a.viewer!, workspace.id),
      this.invitationsFor(a.viewer!),
    ]);

    const others = new Map<string, string[]>();
    for (const row of dmOthers.results) others.set(row.channel_id, [...(others.get(row.channel_id) ?? []), row.principal]);
    const profiles = await this.profiles(slug, workspace, [me, ...dmOthers.results.map((r) => r.principal)]);
    const self = profiles.get(me) ?? null;
    const counts = tally(unread.results, me, self?.name ?? a.viewer!.username, new Map(joined.results.map((row) => [row.id, row.last_read_id])));

    const entries: ChatSidebarEntry[] = joined.results.map((row) => {
      const faces = (others.get(row.id) ?? []).map((key) => profiles.get(key)!).filter(Boolean);
      const count = counts.get(row.id) ?? { unread: 0, mentions: 0 };
      return {
        channel: toChannel(row),
        title: row.kind === "dm" ? dmTitle(faces, self) : (row.name ?? ""),
        others: row.kind === "dm" ? faces.slice(0, DM_FACES) : [],
        starred: !!row.starred,
        muted: !!row.muted,
        unread: count.unread,
        mentions: count.mentions,
      };
    });
    const settings = await this.settings(workspace);
    return ok({
      entries: sidebarOrder(entries),
      browsable: browsable?.n ?? 0,
      can: { ...permissionsFor(settings, role), make_public: role === "owner", invite_guests: mayInviteGuests(a.viewer, slug) },
      ...(role ? {} : { guest: true }),
      workspace: this.chatWorkspace(workspace),
      elsewhere,
      invitations,
    });
  }

  /**
   * The channels of other workspaces the viewer is in as a guest, with
   * their counts: ones of workspaces they are members of are left out,
   * their own sidebars have those. Empty, not an error, when the names of
   * those workspaces cannot be read.
   */
  private async elsewhere(viewer: User, here: string): Promise<GuestChannel[]> {
    const me = userKey(viewer);
    const rows = await this.db
      .prepare(
        `SELECT c.*, m.last_read_id FROM channel_members m JOIN channels c ON c.id = m.channel_id
         WHERE m.principal = ? AND c.workspace_id != ? AND c.kind = 'channel' AND c.archived_at IS NULL
         ORDER BY c.last_message_at DESC LIMIT 100`,
      )
      .bind(me, here)
      .all<ChannelRow & { last_read_id: string | null }>();
    if (!rows.results.length) return [];
    const workspaces = await this.workspacesById(rows.results.map((row) => row.workspace_id));
    const mine = new Set((viewer.workspaces ?? []).map((m) => m.slug.toLowerCase()));
    const theirs = rows.results.filter((row) => {
      const w = workspaces.get(row.workspace_id);
      return !!w && !mine.has(w.slug.toLowerCase());
    });
    if (!theirs.length) return [];
    const unread = await this.db
      .prepare(
        `SELECT msg.channel_id, msg.id, msg.author, msg.mentions
         FROM channel_members m
         JOIN messages msg ON msg.channel_id = m.channel_id AND msg.id > COALESCE(m.last_read_id, '')
         WHERE m.principal = ?1 AND m.channel_id IN (SELECT value FROM json_each(?2))
           AND msg.deleted_at IS NULL AND msg.author != ?1
         LIMIT ${MAX_UNREAD_ROWS}`,
      )
      .bind(me, JSON.stringify(theirs.map((row) => row.id)))
      .all<UnreadRow>();
    const counts = tally(unread.results, me, viewer.username, new Map(theirs.map((row) => [row.id, row.last_read_id])));
    return theirs.map((row) => ({
      workspace: this.chatWorkspace(workspaces.get(row.workspace_id)!),
      channel: toChannel(row),
      unread: counts.get(row.id)?.unread ?? 0,
      mentions: counts.get(row.id)?.mentions ?? 0,
    }));
  }

  /** Workspaces by id: identity names the ids, then each is read by its slug. */
  private async workspacesById(ids: string[]): Promise<Map<string, Workspace>> {
    const unique = [...new Set(ids)];
    const named = await identityClient(this.env.IDENTITY)
      .usernames(unique)
      .catch((error: unknown) => {
        console.error("chat could not name workspaces", error);
        return {} as Record<string, string>;
      });
    const found = await Promise.all(unique.map(async (id) => [id, named[id] ? await this.workspace(named[id]).catch(() => null) : null] as const));
    return new Map(found.filter((entry): entry is readonly [string, Workspace] => !!entry[1] && entry[1].id === entry[0]));
  }

  /** The viewer's open invitations into channels of workspaces they are not in. */
  private async invitationsFor(viewer: User): Promise<ChannelInvitation[]> {
    const rows = await this.db
      .prepare(
        `SELECT c.*, i.id AS invitation_id, i.invitee, i.invited_by, i.created_at AS invited_at
         FROM channel_invitations i JOIN channels c ON c.id = i.channel_id
         WHERE i.invitee = ? AND i.answered_at IS NULL AND c.archived_at IS NULL
         ORDER BY i.created_at DESC LIMIT 50`,
      )
      .bind(userKey(viewer))
      .all<ChannelRow & { invitation_id: string; invitee: string; invited_by: string; invited_at: string }>();
    if (!rows.results.length) return [];
    const workspaces = await this.workspacesById(rows.results.map((row) => row.workspace_id));
    const out: ChannelInvitation[] = [];
    for (const row of rows.results) {
      const workspace = workspaces.get(row.workspace_id);
      if (!workspace) continue;
      const slug = workspace.slug.toLowerCase();
      const profiles = await this.profiles(slug, workspace, [row.invitee, row.invited_by]);
      out.push({
        id: row.invitation_id,
        workspace: this.chatWorkspace(workspace),
        channel: toChannel(row),
        invitee: profiles.get(row.invitee)!,
        invited_by: profiles.get(row.invited_by)!,
        created_at: row.invited_at,
      });
    }
    return out;
  }

  /**
   * What was said in `[from, until)` where the viewer can read: every
   * public channel of the workspace, and the private channels and direct
   * messages they are in (as `place` reads). Text messages and thread
   * replies not deleted; never a card. Message ids sort by time, so each
   * conversation's span is one range of `messages_by_channel`, read in one
   * round trip for them all. Counts only, nothing of what was said.
   */
  async activity(a: { workspace: string; viewer: Viewer; from: string; until: string }): Promise<Result<ChatActivity>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const span = activitySpan(a.from, a.until);
    if (!span) return fail("invalid", "from and until must be RFC 3339 times, from before until.");
    const me = userKey(a.viewer!);
    const rows = await this.db
      .prepare(
        `SELECT msg.channel_id, msg.author, COUNT(*) AS n
         FROM channels c
         JOIN messages msg ON msg.channel_id = c.id AND msg.id >= ?3 AND msg.id < ?4
         WHERE c.workspace_id = ?1 AND c.archived_at IS NULL
           AND (
             (c.kind = 'channel' AND c.private = 0)
             OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.principal = ?2)
           )
           AND msg.deleted_at IS NULL AND msg.kind = 'text'
         GROUP BY msg.channel_id, msg.author`,
      )
      .bind(workspace.id, me, idFloor("msg", span.fromMs), idFloor("msg", span.untilMs))
      .all<ActivityRow>();
    return ok(chatActivity(rows.results, { from: span.from, until: span.until }));
  }

  // ── Channels ────────────────────────────────────────────────────────────

  async channel(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<ChannelDetail>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { slug, workspace, channel, member, role } = found.value;
    const isChannel = channel.kind === "channel";
    // Those who may add people see who is asked in and who asks to come in.
    const admits = isChannel && !!member && !!role;
    const [rows, settings, invited, requests] = await Promise.all([
      this.db.prepare("SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at, principal").bind(channel.id).all<MemberRow>(),
      this.settings(workspace),
      admits
        ? this.db
            .prepare("SELECT * FROM channel_invitations WHERE channel_id = ? AND answered_at IS NULL ORDER BY created_at")
            .bind(channel.id)
            .all<InvitationRow>()
        : { results: [] as InvitationRow[] },
      admits
        ? this.db.prepare("SELECT * FROM channel_requests WHERE channel_id = ? AND answered_at IS NULL ORDER BY created_at").bind(channel.id).all<RequestRow>()
        : { results: [] as RequestRow[] },
    ]);
    const profiles = await this.profiles(slug, workspace, [
      ...rows.results.map((r) => r.principal),
      ...invited.results.flatMap((r) => [r.invitee, r.invited_by]),
      ...requests.results.map((r) => r.requester),
    ]);
    const canManage = isChannel && mayManageChannel(settings, role, member?.role ?? null);
    const mayGuests = mayInviteGuests(a.viewer, slug);
    // Someone outside the workspace is let in only by those who may invite guests.
    const shownRequests = requests.results.filter((r) => mayAdmit(!profiles.get(r.requester)?.guest, !!member, mayGuests));
    return ok({
      channel: toChannel(channel),
      can_manage: canManage,
      can_make_public: isChannel && !channel.private && role === "owner",
      can_invite_guests: isChannel && !!member && mayGuests,
      can_remove_members: canManage,
      ...(role ? {} : { guest: true }),
      workspace: this.chatWorkspace(workspace),
      invited: invited.results.map((row) => ({
        id: row.id,
        workspace: this.chatWorkspace(workspace),
        channel: toChannel(channel),
        invitee: profiles.get(row.invitee)!,
        invited_by: profiles.get(row.invited_by)!,
        created_at: row.created_at,
      })),
      requests: shownRequests.map((row) => ({
        id: row.id,
        channel_id: row.channel_id,
        requester: profiles.get(row.requester)!,
        note: row.note,
        created_at: row.created_at,
      })),
      members: rows.results.map((row) => ({
        channel_id: row.channel_id,
        member: profiles.get(row.principal)!,
        role: row.role,
        starred: !!row.starred,
        muted: !!row.muted,
        last_read_id: row.last_read_id,
        joined_at: row.joined_at,
      })),
    });
  }

  /** A channel by its name, as the site's URLs name them; read like `channel`. */
  async channelByName(a: { workspace: string; name: string; viewer: Viewer }): Promise<Result<ChannelDetail>> {
    const found = await this.visitWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const named = channelName(a.name ?? "");
    if (!named.ok) return fail("not_found", "No such channel.");
    const row = await this.db
      .prepare("SELECT id FROM channels WHERE workspace_id = ? AND name = ?")
      .bind(found.value.workspace.id, named.name)
      .first<{ id: string }>();
    if (!row) return fail("not_found", "No such channel.");
    // A private channel the viewer is not in stays not found there.
    return this.channel({ workspace: a.workspace, channel_id: row.id, viewer: a.viewer });
  }

  /**
   * Every channel the viewer may read: for a member, those kept to the
   * workspace and the public ones; for a guest, the public ones only; and
   * the private ones they are in. A private one they are not in stays
   * unseen. With `archived`, the archived ones.
   */
  async browse(a: { workspace: string; viewer: Viewer; archived?: boolean }): Promise<Result<Channel[]>> {
    const found = await this.visitWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const rows = await this.db
      .prepare(
        `SELECT * FROM channels c
         WHERE c.workspace_id = ?1 AND c.kind = 'channel'
           AND (c.archived_at IS NULL) = (?3 = 0)
           AND ((c.private = 0 AND (?4 = 1 OR c.public = 1))
             OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.principal = ?2))
         ORDER BY c.name`,
      )
      .bind(found.value.workspace.id, userKey(a.viewer!), a.archived === true ? 1 : 0, found.value.role ? 1 : 0)
      .all<ChannelRow>();
    return ok(rows.results.map(toChannel));
  }

  async createChannel(a: { workspace: string; viewer: Viewer; input: NewChannel }): Promise<Result<Channel>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const named = channelName(a.input?.name ?? "");
    if (!named.ok) return fail("invalid", named.message);
    const topic = typeof a.input?.topic === "string" ? a.input.topic.trim() : "";
    if (topic.length > MAX_TOPIC) return fail("invalid", `A topic is at most ${MAX_TOPIC} characters.`);
    const asked = a.input?.visibility;
    if (asked !== undefined && asked !== "private" && asked !== "workspace" && asked !== "public") {
      return fail("invalid", "A channel is private, kept to the workspace, or public.");
    }
    const visibility = asked ?? (a.input?.private ? "private" : "workspace");
    const isPrivate = visibility === "private";
    const role = roleOf(a.viewer, a.workspace);
    if (!mayCreateChannel(await this.settings(workspace), role, isPrivate)) {
      return fail("forbidden", `Only owners can create ${isPrivate ? "private" : "workspace"} channels in this workspace.`);
    }
    // Open to anyone on g1t: the workspace's owners decide that.
    if (visibility === "public" && role !== "owner") return fail("forbidden", "Only workspace owners can make a channel public.");
    const taken = await this.db.prepare("SELECT 1 FROM channels WHERE workspace_id = ? AND name = ?").bind(workspace.id, named.name).first();
    if (taken) return fail("conflict", `#${named.name} already exists.`);
    const me = userKey(a.viewer!);
    const row: ChannelRow = {
      id: newId("chn"),
      workspace_id: workspace.id,
      kind: "channel",
      name: named.name,
      topic: topic || null,
      private: isPrivate ? 1 : 0,
      public: visibility === "public" ? 1 : 0,
      dm_key: null,
      created_by: me,
      created_at: now(),
      archived_at: null,
      last_message_at: null,
    };
    try {
      await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO channels (id, workspace_id, kind, name, topic, private, public, created_by, created_at) VALUES (?, ?, 'channel', ?, ?, ?, ?, ?, ?)",
          )
          .bind(row.id, row.workspace_id, row.name, row.topic, row.private, row.public, me, row.created_at),
        this.joinStatement(row.id, me, "owner", row.created_at),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `#${named.name} already exists.`);
      throw error;
    }
    return ok(toChannel(row));
  }

  async openDm(a: { workspace: string; viewer: Viewer; members: Principal[] }): Promise<Result<Channel>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const slug = a.workspace.toLowerCase();
    const me = userKey(a.viewer!);
    const asked = Array.isArray(a.members) ? a.members : [];
    const principals: Principal[] = [];
    for (const member of asked) {
      const p = member && parsePrincipalKey(`${member.kind}:${member.id}`);
      // A person of the workspace, or @g1t.
      if (!p || (p.kind !== "user" && principalKey(p) !== G1T_KEY)) return fail("invalid", "Each member is a person of the workspace, by id.");
      principals.push(p);
    }
    const members = dmMembers(me, principals.map(principalKey));
    if (members.includes(G1T_KEY) && !g1tDmPerson(members)) {
      return fail("invalid", "A direct message with g1t is just you and g1t.");
    }
    if (members.length > MAX_DM_MEMBERS) {
      return fail("invalid", `A direct message has at most ${MAX_DM_MEMBERS} people. Make a private channel instead.`);
    }
    const key = dmKey(members);
    const existing = await this.db.prepare("SELECT * FROM channels WHERE workspace_id = ? AND dm_key = ?").bind(workspace.id, key).first<ChannelRow>();
    if (existing) return ok(toChannel(existing));

    for (const member of members) {
      // g1t is in every workspace.
      if (member === me || member === G1T_KEY) continue;
      const p = parsePrincipalKey(member)!;
      if (!(await this.belongs(slug, workspace, p))) {
        return fail("not_found", "That person is not in this workspace.");
      }
    }
    const at = now();
    await this.db
      .prepare("INSERT OR IGNORE INTO channels (id, workspace_id, kind, private, dm_key, created_by, created_at) VALUES (?, ?, 'dm', 1, ?, ?, ?)")
      .bind(newId("chn"), workspace.id, key, me, at)
      .run();
    // Read back by key: if two people opened it at once, both get the one that won.
    const channel = await this.db.prepare("SELECT * FROM channels WHERE workspace_id = ? AND dm_key = ?").bind(workspace.id, key).first<ChannelRow>();
    if (!channel) return fail("conflict", "The direct message could not be opened. Try again.");
    await this.db.batch(members.map((member) => this.joinStatement(channel.id, member, "member", at)));
    return ok(toChannel(channel));
  }

  async join(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { channel, member, role } = found.value;
    if (member) return ok(null);
    if (channel.archived_at) return fail("invalid", "This channel is archived.");
    const me = userKey(a.viewer!);
    if (!mayJoin(visibilityOf(channel), role, !role && (await this.removed(channel.id, me)), false)) {
      return fail("forbidden", `You were taken out of #${channel.name}. Ask to be let back in.`);
    }
    await this.joinStatement(channel.id, me, "member", now()).run();
    return ok(null);
  }

  async leave(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { channel, member } = found.value;
    if (!member) return ok(null);
    if (channel.kind === "dm") return fail("invalid", "A direct message can't be left. Mute it instead.");
    const me = userKey(a.viewer!);
    await this.db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND principal = ?").bind(channel.id, me).run();
    // Out of a private channel, they may no longer read it, live either.
    if (channel.private) {
      this.defer(
        this.room(channel.id)
          .drop(me)
          .catch((error: unknown) => console.error("chat could not drop", me, error)),
      );
    }
    return ok(null);
  }

  /**
   * Adds someone to a channel. A member of the workspace joins at once.
   * Anyone else is sent an invitation, which they accept to join as a
   * guest; only those who may invite guests may send one (src/access.ts).
   * Guests themselves add no one.
   */
  async invite(a: { workspace: string; channel_id: string; viewer: Viewer; member: Principal }): Promise<Result<{ invited: boolean }>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "member");
    if (!found.ok) return found;
    const { slug, workspace, channel, role } = found.value;
    if (channel.kind === "dm") return fail("invalid", "People can't be added to a direct message. Start a new one with everyone in it.");
    if (channel.archived_at) return fail("invalid", "This channel is archived.");
    if (!role) return fail("forbidden", "Guests can't add people to a channel.");
    const p = a.member && parsePrincipalKey(`${a.member.kind}:${a.member.id}`);
    if (!p || p.kind !== "user") return fail("invalid", "Invite a person, by id.");
    const key = principalKey(p);
    const at = now();
    if (await this.belongs(slug, workspace, p)) {
      await this.joinStatement(channel.id, key, "member", at).run();
      return ok({ invited: false });
    }
    if (!mayInviteGuests(a.viewer, slug)) {
      return fail("forbidden", "Only workspace owners can ask people outside the workspace into its channels here.");
    }
    if (!this.usernames.has(p.id)) return fail("not_found", "There is no such person on g1t.");
    if (await this.db.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND principal = ?").bind(channel.id, key).first()) {
      return ok({ invited: false });
    }
    // Asking them in again lifts a removal.
    await this.db.batch([
      this.db
        .prepare("INSERT OR IGNORE INTO channel_invitations (id, channel_id, workspace_id, invitee, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(newId("civ"), channel.id, workspace.id, key, userKey(a.viewer!), at),
      this.db.prepare("DELETE FROM channel_removals WHERE channel_id = ? AND principal = ?").bind(channel.id, key),
    ]);
    return ok({ invited: true });
  }

  /**
   * Takes someone out of a channel, and takes back any invitation of
   * theirs still open: whoever may manage the channel. Not yourself (that
   * is leaving), never #general's members, never in a direct message.
   * Someone outside the workspace taken out stays out of a public channel
   * until they are asked in again.
   */
  async removeMember(a: { workspace: string; channel_id: string; viewer: Viewer; member: Principal }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "member");
    if (!found.ok) return found;
    const { slug, workspace, channel, member, role } = found.value;
    if (channel.kind === "dm") return fail("invalid", "No one can be taken out of a direct message.");
    if (!mayManageChannel(await this.settings(workspace), role, member?.role ?? null)) {
      return fail("forbidden", "Only this channel's owners and workspace owners can take people out of it.");
    }
    const p = a.member && parsePrincipalKey(`${a.member.kind}:${a.member.id}`);
    if (!p || p.kind !== "user") return fail("invalid", "Choose a person to take out.");
    const key = principalKey(p);
    if (key === userKey(a.viewer!)) return fail("invalid", "Leave the channel instead.");
    const inside = await this.belongs(slug, workspace, p);
    if (channel.name === GENERAL && inside) return fail("invalid", "#general is where everyone in the workspace is.");
    const at = now();
    const statements = [
      this.db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND principal = ?").bind(channel.id, key),
      this.db
        .prepare("UPDATE channel_invitations SET answered_at = ?, accepted = 0 WHERE channel_id = ? AND invitee = ? AND answered_at IS NULL")
        .bind(at, channel.id, key),
    ];
    if (!inside) {
      statements.push(
        this.db
          .prepare("INSERT OR REPLACE INTO channel_removals (channel_id, principal, removed_by, removed_at) VALUES (?, ?, ?, ?)")
          .bind(channel.id, key, userKey(a.viewer!), at),
      );
    }
    await this.db.batch(statements);
    // Out of it, they read it live no longer, unless anyone may.
    if (channel.private || !inside) {
      this.defer(
        this.room(channel.id)
          .drop(key)
          .catch((error: unknown) => console.error("chat could not drop", key, error)),
      );
    }
    return ok(null);
  }

  /** The viewer's open invitations into other workspaces' channels. */
  async channelInvitations(a: { viewer: Viewer }): Promise<Result<ChannelInvitation[]>> {
    if (!a.viewer) return fail("unauthenticated", "Sign in to see your invitations.");
    return ok(await this.invitationsFor(a.viewer));
  }

  /** Accepts (joining the channel as a guest) or declines an invitation of the viewer's. */
  async answerChannelInvitation(a: { viewer: Viewer; id: string; accept: boolean }): Promise<Result<{ to: string | null }>> {
    const refused = mayVisit(a.viewer);
    if (refused) return fail(a.viewer ? "forbidden" : "unauthenticated", refused);
    const me = userKey(a.viewer!);
    const row = await this.db
      .prepare("SELECT * FROM channel_invitations WHERE id = ? AND invitee = ? AND answered_at IS NULL")
      .bind(String(a.id ?? ""), me)
      .first<InvitationRow>();
    if (!row) return fail("not_found", "That invitation isn't open any more.");
    const channel = await this.db.prepare("SELECT * FROM channels WHERE id = ?").bind(row.channel_id).first<ChannelRow>();
    const at = now();
    const answer = this.db
      .prepare("UPDATE channel_invitations SET answered_at = ?, accepted = ? WHERE id = ? AND answered_at IS NULL")
      .bind(at, a.accept ? 1 : 0, row.id);
    if (!a.accept || !channel || channel.archived_at) {
      await answer.run();
      return a.accept ? fail("invalid", "That channel is archived.") : ok({ to: null });
    }
    await this.db.batch([answer, this.joinStatement(channel.id, me, "member", at)]);
    const [workspace] = (await this.workspacesById([channel.workspace_id])).values();
    return ok({ to: workspace ? `/${workspace.slug.toLowerCase()}/-/chat/${channel.name}` : null });
  }

  /**
   * Asks to be let into a channel by the name in its link. The answer is
   * the same whatever there is, so asking tells no one that a channel they
   * may not see exists; a request is kept only for a channel the viewer
   * cannot read now, of a workspace that exists.
   */
  async requestAccess(a: { workspace: string; name: string; viewer: Viewer; note?: string | null }): Promise<Result<{ requested: true }>> {
    const found = await this.visitWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const { workspace, role } = found.value;
    const named = channelName(a.name ?? "");
    if (!named.ok) return ok({ requested: true });
    const me = userKey(a.viewer!);
    const channel = await this.db
      .prepare("SELECT * FROM channels WHERE workspace_id = ? AND name = ? AND kind = 'channel' AND archived_at IS NULL")
      .bind(workspace.id, named.name)
      .first<ChannelRow>();
    if (channel) {
      const inIt = !!(await this.db.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND principal = ?").bind(channel.id, me).first());
      if (!mayRead(visibilityOf(channel), role, inIt)) {
        await this.db
          .prepare("INSERT OR IGNORE INTO channel_requests (id, channel_id, workspace_id, requester, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(newId("crq"), channel.id, workspace.id, me, requestNote(a.note), now())
          .run();
      }
    }
    return ok({ requested: true });
  }

  /**
   * Lets someone in on their request, or turns it down: anyone in the
   * channel for a member of the workspace; only those who may invite
   * guests for someone outside it, who joins as a guest.
   */
  async answerAccessRequest(a: { workspace: string; channel_id: string; viewer: Viewer; id: string; approve: boolean }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "member");
    if (!found.ok) return found;
    const { slug, workspace, channel, member, role } = found.value;
    if (!role) return fail("forbidden", "Guests can't let people in.");
    const row = await this.db
      .prepare("SELECT * FROM channel_requests WHERE id = ? AND channel_id = ? AND answered_at IS NULL")
      .bind(String(a.id ?? ""), channel.id)
      .first<RequestRow>();
    if (!row) return fail("not_found", "That request has been answered.");
    const requester = parsePrincipalKey(row.requester);
    if (!requester || requester.kind !== "user") return fail("not_found", "That request has been answered.");
    const inside = await this.belongs(slug, workspace, requester);
    if (!mayAdmit(inside, !!member, mayInviteGuests(a.viewer, slug))) {
      return fail("forbidden", "Only workspace owners can let people outside the workspace in here.");
    }
    const at = now();
    const statements = [
      this.db
        .prepare("UPDATE channel_requests SET answered_at = ?, answered_by = ?, approved = ? WHERE id = ? AND answered_at IS NULL")
        .bind(at, userKey(a.viewer!), a.approve ? 1 : 0, row.id),
    ];
    if (a.approve) {
      if (channel.archived_at) return fail("invalid", "This channel is archived.");
      statements.push(this.joinStatement(channel.id, row.requester, "member", at));
      statements.push(this.db.prepare("DELETE FROM channel_removals WHERE channel_id = ? AND principal = ?").bind(channel.id, row.requester));
      // Kept as an accepted invitation, so making the channel workspace-only again keeps them as a guest.
      if (!inside) {
        statements.push(
          this.db
            .prepare(
              "INSERT INTO channel_invitations (id, channel_id, workspace_id, invitee, invited_by, created_at, answered_at, accepted) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
            )
            .bind(newId("civ"), channel.id, workspace.id, row.requester, userKey(a.viewer!), at, at),
        );
      }
    }
    await this.db.batch(statements);
    return ok(null);
  }

  async setPreferences(a: { workspace: string; channel_id: string; viewer: Viewer; prefs: { starred?: boolean; muted?: boolean } }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "member");
    if (!found.ok) return found;
    const starred = typeof a.prefs?.starred === "boolean" ? (a.prefs.starred ? 1 : 0) : null;
    const muted = typeof a.prefs?.muted === "boolean" ? (a.prefs.muted ? 1 : 0) : null;
    await this.db
      .prepare("UPDATE channel_members SET starred = COALESCE(?, starred), muted = COALESCE(?, muted) WHERE channel_id = ? AND principal = ?")
      .bind(starred, muted, found.value.channel.id, userKey(a.viewer!))
      .run();
    // Notify: the badge counts the conversation again, or leaves it out, in every tab.
    if (muted !== null) {
      this.defer(
        notifyMuted(this.env.NOTIFY, { slug: found.value.slug, channel_id: found.value.channel.id, user_id: a.viewer!.id, muted: !!muted }).catch((error) =>
          console.error("chat could not notify a mute", error),
        ),
      );
    }
    return ok(null);
  }

  // ── What owners decide (src/settings.ts) ────────────────────────────────

  /** The row of a workspace's chat settings, read once per request. */
  private settingsRow(workspace: Workspace): Promise<SettingsRow | null> {
    let found = this.settingsRows.get(workspace.id);
    if (!found) {
      found = this.db
        .prepare("SELECT emoji_upload, public_channels, private_channels, manage_channels, default_channels FROM chat_settings WHERE workspace_id = ?")
        .bind(workspace.id)
        .first<SettingsRow>();
      this.settingsRows.set(workspace.id, found);
    }
    return found;
  }

  /**
   * A workspace's chat settings. Default channels never chosen are
   * #general, looked up unless `generalId` is given.
   */
  private async settings(workspace: Workspace, generalId?: string | null): Promise<ChatSettings> {
    const row = await this.settingsRow(workspace);
    if (row?.default_channels != null || generalId !== undefined) return settingsOf(row, generalId ?? null);
    const general = await this.db
      .prepare("SELECT id FROM channels WHERE workspace_id = ? AND name = ? AND kind = 'channel'")
      .bind(workspace.id, GENERAL)
      .first<{ id: string }>();
    return settingsOf(row, general?.id ?? null);
  }

  async chatSettings(a: { workspace: string; viewer: Viewer }): Promise<Result<ChatSettingsView>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const [settings, channels] = await Promise.all([
      this.settings(workspace),
      this.db
        .prepare("SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND private = 0 AND archived_at IS NULL ORDER BY name")
        .bind(workspace.id)
        .all<ChannelRow>(),
    ]);
    return ok({ settings, can: permissionsFor(settings, roleOf(a.viewer, a.workspace)), channels: channels.results.map(toChannel) });
  }

  async setChatSettings(a: { workspace: string; viewer: Viewer; change: Partial<ChatSettings> }): Promise<Result<ChatSettings>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    if (roleOf(a.viewer, a.workspace) !== "owner") return fail("forbidden", "Only owners can change the workspace's chat settings.");
    const checked = settingsChange(a.change);
    if (!checked.ok) return fail("invalid", checked.message);
    const change = checked.change;
    if (change.default_channels) {
      // Only the workspace's public channels that are not archived: a private
      // one would put people somewhere they were never invited.
      const rows = await this.db
        .prepare(
          "SELECT id FROM channels WHERE workspace_id = ? AND kind = 'channel' AND private = 0 AND archived_at IS NULL AND id IN (SELECT value FROM json_each(?))",
        )
        .bind(workspace.id, JSON.stringify(change.default_channels))
        .all<{ id: string }>();
      const open = new Set(rows.results.map((r) => r.id));
      if (change.default_channels.some((id) => !open.has(id))) return fail("invalid", "Default channels must be public channels that are not archived.");
    }
    const next: ChatSettings = { ...(await this.settings(workspace)), ...change };
    const row = rowFor(next);
    await this.db
      .prepare(
        `INSERT INTO chat_settings (workspace_id, emoji_upload, public_channels, private_channels, manage_channels, default_channels)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (workspace_id) DO UPDATE SET emoji_upload = ?2, public_channels = ?3, private_channels = ?4, manage_channels = ?5, default_channels = ?6`,
      )
      .bind(workspace.id, row.emoji_upload, row.public_channels, row.private_channels, row.manage_channels, row.default_channels)
      .run();
    this.settingsRows.delete(workspace.id);
    return ok(next);
  }

  /**
   * Renames, archives or unarchives a channel, or changes its topic. The
   * workspace's `manage_channels` setting says who may do the first three;
   * any member may change the topic. #general stays #general, and stays.
   */
  async updateChannel(a: { workspace: string; channel_id: string; viewer: Viewer; change: ChannelChange }): Promise<Result<Channel>> {
    // Archived or not, a channel is found the same way; a private one only by its members.
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { slug, workspace, channel, member, role } = found.value;
    if (channel.kind === "dm") return fail("invalid", "A direct message has no name or topic to change.");
    if (!role) return fail("forbidden", "Guests can't change a channel.");
    const change = a.change ?? {};
    const next: ChannelRow = { ...channel };
    // Only the workspace's owners open a channel to anyone on g1t, or keep it to the workspace again.
    let closing = false;
    if (change.visibility !== undefined) {
      if (change.visibility !== "workspace" && change.visibility !== "public") {
        return fail("invalid", "A channel is made public, or kept to the workspace. A private channel stays private.");
      }
      if (role !== "owner") return fail("forbidden", "Only workspace owners can make a channel public, or keep it to the workspace.");
      if (channel.private) return fail("invalid", "A private channel stays private. Make a public one instead.");
      if (channel.archived_at) return fail("invalid", "This channel is archived. Unarchive it first.");
      next.public = change.visibility === "public" ? 1 : 0;
      closing = !!channel.public && !next.public;
    }
    if (change.name !== undefined || change.archived !== undefined) {
      const settings = await this.settings(workspace);
      if (!mayManageChannel(settings, roleOf(a.viewer, slug), member?.role ?? null)) {
        return fail(
          "forbidden",
          settings.manage_channels === "owners"
            ? "Only workspace owners can rename or archive channels here."
            : "Only this channel's owners and workspace owners can rename or archive it.",
        );
      }
      if (channel.name === GENERAL) return fail("invalid", "#general is where everyone is: it can't be renamed or archived.");
    }
    if (change.name !== undefined) {
      const named = channelName(String(change.name ?? ""));
      if (!named.ok) return fail("invalid", named.message);
      if (named.name !== channel.name) {
        const taken = await this.db
          .prepare("SELECT 1 FROM channels WHERE workspace_id = ? AND name = ? AND id != ?")
          .bind(workspace.id, named.name, channel.id)
          .first();
        if (taken || named.name === GENERAL) return fail("conflict", `#${named.name} already exists.`);
      }
      next.name = named.name;
    }
    if (change.topic !== undefined) {
      if (!member) return fail("forbidden", `Join #${channel.name} first.`);
      const topic = typeof change.topic === "string" ? change.topic.trim() : "";
      if (topic.length > MAX_TOPIC) return fail("invalid", `A topic is at most ${MAX_TOPIC} characters.`);
      next.topic = topic || null;
    }
    if (change.archived !== undefined) {
      next.archived_at = change.archived ? (channel.archived_at ?? now()) : null;
    } else if (channel.archived_at && (change.name !== undefined || change.topic !== undefined)) {
      return fail("invalid", "This channel is archived. Unarchive it first.");
    }
    try {
      await this.db
        .prepare("UPDATE channels SET name = ?, topic = ?, archived_at = ?, public = ? WHERE id = ?")
        .bind(next.name, next.topic, next.archived_at, next.public, channel.id)
        .run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `#${next.name} already exists.`);
      throw error;
    }
    if (closing) await this.dropVisitors(slug, workspace, channel.id);
    const updated = toChannel(next);
    this.broadcast(channel.id, { type: "channel.updated", channel: updated });
    return ok(updated);
  }

  /**
   * A channel kept to the workspace again: everyone outside it who came in
   * on their own while it was public goes, and reads it live no longer.
   * Guests asked in (or let in on a request) stay.
   */
  private async dropVisitors(slug: string, workspace: Workspace, channelId: string): Promise<void> {
    const [rows, asked] = await Promise.all([
      this.db.prepare("SELECT principal FROM channel_members WHERE channel_id = ? AND principal LIKE 'user:%'").bind(channelId).all<{ principal: string }>(),
      this.db.prepare("SELECT invitee FROM channel_invitations WHERE channel_id = ? AND accepted = 1").bind(channelId).all<{ invitee: string }>(),
    ]);
    const kept = new Set(asked.results.map((r) => r.invitee));
    const visitors: string[] = [];
    for (const { principal } of rows.results) {
      if (kept.has(principal)) continue;
      const p = parsePrincipalKey(principal);
      if (p && !(await this.belongs(slug, workspace, p))) visitors.push(principal);
    }
    if (!visitors.length) return;
    await this.db
      .prepare("DELETE FROM channel_members WHERE channel_id = ? AND principal IN (SELECT value FROM json_each(?))")
      .bind(channelId, JSON.stringify(visitors))
      .run();
    for (const key of visitors) {
      this.defer(
        this.room(channelId)
          .drop(key)
          .catch((error: unknown) => console.error("chat could not drop", key, error)),
      );
    }
  }

  // ── Messages ────────────────────────────────────────────────────────────

  /**
   * Newest first, a page at a time. With `thread_root`, that thread's
   * replies, and the message they reply to as the oldest once the page
   * reaches the start of the thread; without, the channel's top-level
   * messages. A deleted message stays only while replies hang off it.
   */
  async messages(a: {
    workspace: string;
    channel_id: string;
    viewer: Viewer;
    before?: string | null;
    after?: string | null;
    limit?: number | null;
    thread_root?: string | null;
  }): Promise<Result<MessagePage>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { slug, workspace, channel } = found.value;
    const size = pageSize(a.limit);
    // Ids are lowercase letters, digits and `_`, so `~` sorts after every
    // one: the first page reads from the newest as a range of the index.
    const before = typeof a.before === "string" && a.before ? a.before : "~";
    const root = typeof a.thread_root === "string" && a.thread_root ? a.thread_root : null;
    if (typeof a.after === "string" && a.after) {
      // Catching up after a reconnect: what came after, oldest first. Deleted
      // ones too, so the client drops them; read one past the page to know
      // whether there is more.
      const newer = root
        ? await this.db
            .prepare("SELECT * FROM messages WHERE thread_root = ? AND channel_id = ? AND id > ? ORDER BY id LIMIT ?")
            .bind(root, channel.id, a.after, size + 1)
            .all<MessageRow>()
        : await this.db
            .prepare("SELECT * FROM messages WHERE channel_id = ? AND thread_root IS NULL AND id > ? ORDER BY id LIMIT ?")
            .bind(channel.id, a.after, size + 1)
            .all<MessageRow>();
      const page = pageOf(newer.results, size);
      return ok({ messages: await this.toMessages(slug, workspace, page.rows, userKey(a.viewer!)), older: null, newer: page.older });
    }
    const rows = root
      ? await this.db
          .prepare(
            `SELECT * FROM messages WHERE thread_root = ?1 AND channel_id = ?2 AND id < ?3
             ORDER BY id DESC LIMIT ?4`,
          )
          .bind(root, channel.id, before, size + 1)
          .all<MessageRow>()
      : await this.db
          .prepare(
            `SELECT * FROM messages
             WHERE channel_id = ?1 AND thread_root IS NULL AND id < ?2
               AND (deleted_at IS NULL OR reply_count > 0)
             ORDER BY id DESC LIMIT ?3`,
          )
          .bind(channel.id, before, size + 1)
          .all<MessageRow>();
    const page = pageOf(rows.results, size);
    let list = page.rows;
    // The message a thread is under: the oldest once the page reaches the
    // start, and, on the first page, as `root` however long the thread is,
    // so what the thread replies to stays at the top of it.
    const firstPage = before === "~";
    const rootRow = root && (page.older === null || firstPage) ? await this.messageRow(channel.id, root) : null;
    if (rootRow && page.older === null) list = [...list, rootRow];
    const messages = await this.toMessages(slug, workspace, list, userKey(a.viewer!));
    if (!rootRow || !firstPage) return ok({ messages, older: page.older });
    const shown = messages.find((m) => m.id === rootRow.id) ?? (await this.toMessages(slug, workspace, [rootRow], userKey(a.viewer!)))[0] ?? null;
    return ok({ messages, older: page.older, root: shown });
  }

  /**
   * Writes a message and everything that follows from it: the thread's
   * reply count, the channel's last activity, the author's own read mark,
   * the meter; then, after answering, tells the room and notifies the
   * people it is for.
   */
  private async write(
    place: Place,
    author: string,
    input: { body: string; card: MessageCard | null; thread_root: string | null },
    options: { meta?: MessageMeta; notify?: boolean } = {},
  ): Promise<Result<ChatMessage>> {
    const { channel, workspace } = place;
    if (channel.archived_at) return fail("invalid", "This channel is archived.");
    let threadRoot: string | null = null;
    if (input.thread_root) {
      const root = await this.messageRow(channel.id, input.thread_root);
      if (!root || (root.deleted_at && !root.reply_count)) return fail("not_found", "No such message to reply to.");
      // A reply to a reply goes in the same thread.
      threadRoot = root.thread_root ?? root.id;
    }
    const at = now();
    const body = input.body;
    const handles = mentionedHandles(body);
    const row: MessageRow = {
      id: newId("msg"),
      channel_id: channel.id,
      author,
      kind: input.card ? "card" : "text",
      body,
      card: input.card ? JSON.stringify(input.card) : null,
      mentions: mentionsColumn(handles),
      thread_root: threadRoot,
      reply_count: 0,
      last_reply_at: null,
      created_at: at,
      edited_at: null,
      deleted_at: null,
      meta: metaColumn(options.meta ?? {}),
    };
    const statements = [
      this.db
        .prepare(
          "INSERT INTO messages (id, channel_id, author, kind, body, card, mentions, thread_root, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(row.id, row.channel_id, author, row.kind, row.body, row.card, row.mentions, threadRoot, at, row.meta),
      this.db.prepare("UPDATE channels SET last_message_at = ? WHERE id = ?").bind(at, channel.id),
      // What you wrote, you have read.
      this.db.prepare("UPDATE channel_members SET last_read_id = ? WHERE channel_id = ? AND principal = ?").bind(row.id, channel.id, author),
      this.db
        .prepare(
          `INSERT INTO chat_meter (workspace_id, day, messages, bytes) VALUES (?, ?, 1, ?)
           ON CONFLICT (workspace_id, day) DO UPDATE SET messages = messages + 1, bytes = bytes + excluded.bytes`,
        )
        .bind(workspace.id, meterDay(at), bytesOf(row.body) + bytesOf(row.card ?? "")),
    ];
    if (threadRoot) {
      statements.push(this.db.prepare("UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?").bind(at, threadRoot));
    }
    await this.db.batch(statements);

    const [message] = await this.toMessages(place.slug, workspace, [row]);
    this.broadcast(channel.id, { type: "message.created", message });
    if (threadRoot) this.rebroadcast(place, threadRoot);
    // An answer from @g1t notifies when it ends (src/room.ts), not while it is empty.
    if (options.notify === false) return ok(message);
    // Notify: counts for everyone in the conversation, a notification for those it is for.
    this.defer(
      notifyMessage(this.db, this.env.NOTIFY, (keys) => this.profiles(place.slug, workspace, keys), { slug: place.slug, channel, row, handles }).catch(
        (error) => console.error("chat could not notify about", row.id, error),
      ),
    );
    return ok(message);
  }

  async post(a: { workspace: string; channel_id: string; viewer: Viewer; message: PostMessage }): Promise<Result<ChatMessage>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const body = messageBody(a.message?.body);
    if (!body.ok) return fail("invalid", body.message);
    const me = userKey(a.viewer!);
    let place = found.value;
    if (!place.member) {
      // Saying something in a channel anyone may join joins it, as reading does not.
      if (place.channel.archived_at) return fail("invalid", "This channel is archived.");
      if (!place.role && (await this.removed(place.channel.id, me))) {
        return fail("forbidden", `You were taken out of #${place.channel.name}. Ask to be let back in.`);
      }
      await this.joinStatement(place.channel.id, me, "member", now()).run();
      place = { ...place, member: { channel_id: place.channel.id, principal: me } as MemberRow };
    }
    const input = { body: body.body, card: null, thread_root: a.message?.thread_root ?? null };
    const members = place.channel.kind === "dm" ? await this.memberKeys(place.channel.id) : [];
    // @g1t works for the workspace's members alone: a guest never starts an answer, wherever they are.
    if (!place.role || !startsAnswer({ channelKind: place.channel.kind, members, author: me, threadRoot: input.thread_root, card: false, body: input.body })) {
      return this.write(place, me, input);
    }
    // A question for @g1t: kept with the page it was asked from, then answered.
    const page = pageFrom(a.message?.page);
    const written = await this.write(place, me, input, { meta: page ? { page } : {} });
    if (written.ok) this.defer(this.startAnswer(place, a.viewer!).catch((error) => console.error("g1t could not start an answer in", place.channel.id, error)));
    return written;
  }

  private async memberKeys(channelId: string): Promise<string[]> {
    const rows = await this.db.prepare("SELECT principal FROM channel_members WHERE channel_id = ?").bind(channelId).all<{ principal: string }>();
    return rows.results.map((row) => row.principal);
  }

  // ── @g1t (src/g1t.ts, src/answer.ts) ────────────────────────────────────

  /**
   * Starts @g1t's answer to what was last said in its direct message: an
   * empty message from g1t, `thinking`, which the channel's room writes the
   * answer into as it streams (src/room.ts `startAnswer`).
   */
  private async startAnswer(place: Place, viewer: User): Promise<void> {
    const recent = await this.db
      .prepare("SELECT id, author, kind, body, meta, deleted_at FROM messages WHERE channel_id = ? AND thread_root IS NULL ORDER BY id DESC LIMIT 120")
      .bind(place.channel.id)
      .all<SaidRow>();
    const rows = recent.results.reverse();
    const messages = conversation(rows);
    if (!messages.length) return;
    // The question it answers: a clear that deletes it also throws this answer away (src/room.ts).
    const question = latestQuestion(rows);
    const written = await this.write(place, G1T_KEY, { body: "", card: null, thread_root: null }, { meta: { answer: { state: "thinking" } }, notify: false });
    if (!written.ok) return;
    const { channel } = place;
    await this.room(channel.id).startAnswer({
      slug: place.slug,
      channel: { id: channel.id, kind: channel.kind, name: channel.name },
      actor: viewer,
      messages,
      // The page of the newest question; one asked in Chat is on the direct message itself.
      page: { ...latestPage(rows), path: latestPage(rows)?.path ?? `/${place.slug}/-/chat/dm/${channel.id}` },
      message: written.value,
      question_id: question ?? undefined,
    });
  }

  /** The viewer's direct message with @g1t, checked: theirs, and with g1t. */
  private async g1tPlace(slug: string, channelId: string, viewer: Viewer): Promise<Result<Place>> {
    const found = await this.place(slug, channelId, viewer, "member");
    if (!found.ok) return found;
    if (found.value.channel.kind !== "dm" || g1tDmPerson(await this.memberKeys(found.value.channel.id)) !== userKey(viewer!)) {
      return fail("invalid", "That is not a direct message with g1t.");
    }
    return found;
  }

  async g1tDm(a: { workspace: string; viewer: Viewer }): Promise<Result<Channel>> {
    return this.openDm({ workspace: a.workspace, viewer: a.viewer, members: [G1T_PRINCIPAL] });
  }

  /**
   * "New conversation": stops an answer still coming, and leaves a mark
   * after which g1t reads only what is said next. Everything before stays
   * to read.
   */
  async g1tReset(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<ChatMessage>> {
    const found = await this.g1tPlace(a.workspace, a.channel_id, a.viewer);
    if (!found.ok) return found;
    await this.room(found.value.channel.id).stopAnswer();
    const written = await this.write(
      found.value,
      G1T_KEY,
      { body: "New conversation", card: null, thread_root: null },
      { meta: { reset: true }, notify: false },
    );
    if (written.ok) {
      // Their own mark is read.
      await this.db
        .prepare("UPDATE channel_members SET last_read_id = ? WHERE channel_id = ? AND principal = ?")
        .bind(written.value.id, found.value.channel.id, userKey(a.viewer!))
        .run();
    }
    return written;
  }

  /**
   * "Clear conversation": deletes everything in the viewer's own direct
   * message with @g1t for good (src/clear.ts), so g1t remembers none of
   * it. Only that person, in their own; never a channel or anyone else's.
   * Then the room throws away an answer still being written, so it cannot
   * write what it read back in, and notify forgets their notifications
   * from it. Clearing an empty conversation does nothing and says 0.
   */
  async g1tClear(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<{ cleared: number }>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "member");
    if (!found.ok) return found;
    const place = found.value;
    const me = userKey(a.viewer!);
    if (!mayClear({ channelKind: place.channel.kind, members: await this.memberKeys(place.channel.id), viewer: me })) {
      return fail("invalid", "Only your own direct message with g1t can be cleared.");
    }
    // Deleted first, then the room: an answer that reads after this finds its question gone (src/room.ts).
    const { messages } = await clearConversation(this.db, place.channel.id);
    await this.room(place.channel.id).clear(place.channel.id);
    await notifyCleared(this.env.NOTIFY, { slug: place.slug, channel_id: place.channel.id, user_id: a.viewer!.id }).catch((error: unknown) =>
      console.error("chat could not have notify forget", place.channel.id, error),
    );
    return ok({ cleared: messages });
  }

  /** Answers the latest question again: g1t's last answer goes, and a new one is written. */
  async g1tRetry(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<null>> {
    const found = await this.g1tPlace(a.workspace, a.channel_id, a.viewer);
    if (!found.ok) return found;
    const place = found.value;
    const last = await this.db
      .prepare("SELECT * FROM messages WHERE channel_id = ? AND thread_root IS NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 1")
      .bind(place.channel.id)
      .first<MessageRow>();
    if (!last || (last.author === G1T_KEY && parseMeta(last.meta).reset)) return fail("invalid", "There is no question to answer again.");
    if (last.author === G1T_KEY) {
      await this.room(place.channel.id).stopAnswer();
      await this.db.prepare("UPDATE messages SET deleted_at = ?, body = '', meta = NULL WHERE id = ?").bind(now(), last.id).run();
      this.broadcast(place.channel.id, { type: "message.deleted", channel_id: place.channel.id, id: last.id });
    }
    await this.startAnswer(place, a.viewer!);
    return ok(null);
  }

  /**
   * Keeps what a proposal's card did (components/ask-steps on the site) on
   * the answer that proposed it, step by step, so the card shows it again
   * wherever the answer is read, and a second click carries on rather than
   * starting over. Only in the viewer's own direct message with g1t. With
   * no change but the id, says what was kept.
   */
  async g1tProposal(a: { workspace: string; channel_id: string; viewer: Viewer; message_id: string; state: ProposalState }): Promise<Result<ProposalState>> {
    const found = await this.g1tPlace(a.workspace, a.channel_id, a.viewer);
    if (!found.ok) return found;
    const place = found.value;
    const row = await this.messageRow(place.channel.id, String(a.message_id ?? ""));
    if (!row || row.deleted_at || row.author !== G1T_KEY) return fail("not_found", "No such answer from g1t.");
    const meta = parseMeta(row.meta);
    const merged = meta.answer && a.state && typeof a.state.id === "string" ? withProposalState(meta.answer, a.state) : null;
    if (!merged) return fail("not_found", "That answer proposed no such session.");
    const column = metaColumn({ ...meta, answer: merged.answer });
    await this.db.prepare("UPDATE messages SET meta = ? WHERE id = ?").bind(column, row.id).run();
    const [message] = await this.toMessages(place.slug, place.workspace, [{ ...row, meta: column }]);
    this.broadcast(place.channel.id, { type: "message.updated", message });
    return ok(merged.state);
  }

  async g1tStop(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<null>> {
    const found = await this.g1tPlace(a.workspace, a.channel_id, a.viewer);
    if (!found.ok) return found;
    await this.room(found.value.channel.id).stopAnswer();
    return ok(null);
  }

  /**
   * For g1t's own services (`POST /internal/g1t_post`): says something as
   * @g1t in a direct message with it. Never reached from the site.
   */
  async internalG1tPost(a: { workspace: string; channel_id: string; body: string }): Promise<Result<ChatMessage>> {
    const found = await this.internalPlace(a.workspace, a.channel_id);
    if (!found.ok) return found;
    const body = messageBody(a.body);
    if (!body.ok) return fail("invalid", body.message);
    return this.write(found.value, G1T_KEY, { body: body.body, card: null, thread_root: null });
  }

  /** `POST /internal/g1t_edit`: changes one of @g1t's messages in a direct message with it. */
  async internalG1tEdit(a: { workspace: string; channel_id: string; id: string; body: string }): Promise<Result<ChatMessage>> {
    const found = await this.internalPlace(a.workspace, a.channel_id);
    if (!found.ok) return found;
    const place = found.value;
    const row = await this.messageRow(place.channel.id, a.id);
    if (!row || row.deleted_at || row.author !== G1T_KEY) return fail("not_found", "No such message from g1t.");
    const body = messageBody(a.body);
    if (!body.ok) return fail("invalid", body.message);
    const at = now();
    await this.db.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").bind(body.body, at, row.id).run();
    const [message] = await this.toMessages(place.slug, place.workspace, [{ ...row, body: body.body, edited_at: at }]);
    this.broadcast(place.channel.id, { type: "message.updated", message });
    return ok(message);
  }

  /** A direct message with @g1t, by the workspace's slug and the channel's id, for g1t's own services. */
  private async internalPlace(slug: string, channelId: string): Promise<Result<Place>> {
    const workspace = await this.workspace(String(slug ?? ""));
    if (!workspace) return fail("not_found", "No such workspace.");
    const channel = await this.db
      .prepare("SELECT * FROM channels WHERE id = ? AND workspace_id = ?")
      .bind(String(channelId ?? ""), workspace.id)
      .first<ChannelRow>();
    if (!channel || channel.kind !== "dm" || !g1tDmPerson(await this.memberKeys(channel.id))) return fail("not_found", "No such direct message with g1t.");
    return ok({ slug: workspace.slug.toLowerCase(), workspace, channel, member: null, role: null });
  }

  async edit(a: { workspace: string; channel_id: string; viewer: Viewer; id: string; body: string }): Promise<Result<ChatMessage>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const place = found.value;
    const row = await this.messageRow(place.channel.id, a.id);
    if (!row || row.deleted_at) return fail("not_found", "No such message.");
    if (row.author !== userKey(a.viewer!)) return fail("forbidden", "Only its author can edit a message.");
    const body = messageBody(a.body, !!row.card);
    if (!body.ok) return fail("invalid", body.message);
    const at = now();
    const mentions = mentionsColumn(mentionedHandles(body.body));
    await this.db.prepare("UPDATE messages SET body = ?, mentions = ?, edited_at = ? WHERE id = ?").bind(body.body, mentions, at, row.id).run();
    const [message] = await this.toMessages(place.slug, place.workspace, [{ ...row, body: body.body, mentions, edited_at: at }]);
    this.broadcast(place.channel.id, { type: "message.updated", message });
    return ok(message);
  }

  /** Deletes a message, keeping its place so its thread still hangs together. Its author or a workspace owner may. */
  async remove(a: { workspace: string; channel_id: string; viewer: Viewer; id: string }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const place = found.value;
    const row = await this.messageRow(place.channel.id, a.id);
    if (!row || row.deleted_at) return fail("not_found", "No such message.");
    const me = userKey(a.viewer!);
    // In your direct message with @g1t, g1t's messages are yours to delete too.
    const g1tsInMine = row.author === G1T_KEY && place.channel.kind === "dm" && g1tDmPerson(await this.memberKeys(place.channel.id)) === me;
    if (row.author !== me && !isOwner(a.viewer, a.workspace) && !g1tsInMine) {
      return fail("forbidden", "Only its author or a workspace owner can delete a message.");
    }
    const statements = [this.db.prepare("UPDATE messages SET deleted_at = ?, body = '', card = NULL, mentions = '' WHERE id = ?").bind(now(), row.id)];
    if (row.thread_root) {
      statements.push(this.db.prepare("UPDATE messages SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?").bind(row.thread_root));
    }
    await this.db.batch(statements);
    this.broadcast(place.channel.id, { type: "message.deleted", channel_id: place.channel.id, id: row.id });
    if (row.thread_root) this.rebroadcast(place, row.thread_root);
    return ok(null);
  }

  async markRead(a: { workspace: string; channel_id: string; viewer: Viewer; id: string }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { channel, member } = found.value;
    // Someone reading a public channel they have not joined keeps no read state.
    if (!member) return ok(null);
    const id = typeof a.id === "string" ? a.id : "";
    if (!id) return fail("invalid", "Say which message was read.");
    // Only forward: reading an old thread does not mark newer messages unread.
    const changed = await this.db
      .prepare("UPDATE channel_members SET last_read_id = ?1 WHERE channel_id = ?2 AND principal = ?3 AND (last_read_id IS NULL OR last_read_id < ?1)")
      .bind(id, channel.id, member.principal)
      .run();
    if (changed.meta.changes) {
      this.broadcast(channel.id, {
        type: "read",
        channel_id: channel.id,
        principal: { kind: "user", id: a.viewer!.id },
        last_read_id: id,
      });
      // Notify: the read drops the counts in every tab of theirs.
      this.defer(
        notifyRead(this.db, this.env.NOTIFY, {
          slug: found.value.slug,
          channel_id: channel.id,
          user_id: a.viewer!.id,
          username: a.viewer!.username,
          last_read_id: id,
        }).catch((error) => console.error("chat could not notify a read", error)),
      );
    }
    return ok(null);
  }

  // ── Reactions (src/emoji.ts) ────────────────────────────────────────────

  /** One message's reactions now, as `me` sees them. */
  private async reactionsFor(place: Place, messageId: string, me: string): Promise<ChatReaction[]> {
    const list = (await this.reactionsOf([messageId], me)).get(messageId) ?? [];
    const profiles = await this.profiles(
      place.slug,
      place.workspace,
      list.flatMap((r) => r.by),
    );
    return list.map((r) => ({ ...r, by: r.by.map((key) => profiles.get(key)!).filter(Boolean) }));
  }

  /**
   * Adds or takes back `who`'s reaction. Each member reacts once with each
   * emoji, a message holds at most 50 different ones, and a workspace's own
   * emoji must exist to be used (taking one back never needs it to). The
   * room hears of each change.
   */
  private async reactTo(place: Place, who: string, messageId: unknown, input: unknown, remove: boolean): Promise<Result<ChatReaction[]>> {
    const parsed = reactionEmoji(input);
    if (!parsed.ok) return fail("invalid", parsed.message);
    const row = await this.messageRow(place.channel.id, String(messageId ?? ""));
    if (!row || row.deleted_at) return fail("not_found", "No such message.");
    let changed = 0;
    if (remove) {
      const done = await this.db.prepare("DELETE FROM reactions WHERE message_id = ? AND principal = ? AND emoji = ?").bind(row.id, who, parsed.emoji).run();
      changed = done.meta.changes;
    } else {
      if (parsed.custom) {
        const known = await this.db
          .prepare("SELECT 1 FROM custom_emoji WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL")
          .bind(place.workspace.id, parsed.custom)
          .first();
        if (!known) return fail("not_found", `This workspace has no :${parsed.custom}: emoji.`);
      }
      const kinds = await this.db.prepare("SELECT DISTINCT emoji FROM reactions WHERE message_id = ?").bind(row.id).all<{ emoji: string }>();
      if (!roomForReaction(new Set(kinds.results.map((k) => k.emoji)), parsed.emoji)) {
        return fail("invalid", `A message can have at most ${MAX_REACTIONS_PER_MESSAGE} different reactions.`);
      }
      const done = await this.db
        .prepare("INSERT OR IGNORE INTO reactions (message_id, principal, emoji, created_at) VALUES (?, ?, ?, ?)")
        .bind(row.id, who, parsed.emoji, now())
        .run();
      changed = done.meta.changes;
    }
    if (changed) {
      const member = await this.profile(place.slug, place.workspace, who);
      this.broadcast(place.channel.id, {
        type: remove ? "reaction.removed" : "reaction.added",
        channel_id: place.channel.id,
        message_id: row.id,
        emoji: parsed.emoji,
        member,
      });
    }
    return ok(await this.reactionsFor(place, row.id, who));
  }

  async react(a: { workspace: string; channel_id: string; viewer: Viewer; message_id: string; emoji: string }): Promise<Result<ChatReaction[]>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    return this.reactTo(found.value, userKey(a.viewer!), a.message_id, a.emoji, false);
  }

  async unreact(a: { workspace: string; channel_id: string; viewer: Viewer; message_id: string; emoji: string }): Promise<Result<ChatReaction[]>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    return this.reactTo(found.value, userKey(a.viewer!), a.message_id, a.emoji, true);
  }

  // ── A workspace's own emoji (src/emoji.ts) ──────────────────────────────

  private async emojiUpload(workspace: Workspace): Promise<EmojiUpload> {
    return settingsOf(await this.settingsRow(workspace)).emoji_upload;
  }

  private async toEmoji(slug: string, workspace: Workspace, rows: EmojiRow[]): Promise<CustomEmoji[]> {
    const profiles = await this.profiles(
      slug,
      workspace,
      rows.map((r) => r.created_by),
    );
    return rows.map((row) => ({
      name: row.name,
      alias_of: row.alias_of,
      file: row.file,
      content_type: row.content_type,
      bytes: row.bytes,
      created_by: profiles.get(row.created_by)!,
      created_at: row.created_at,
    }));
  }

  private liveEmoji(workspace: Workspace, name: string): Promise<EmojiRow | null> {
    return this.db.prepare("SELECT * FROM custom_emoji WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL").bind(workspace.id, name).first<EmojiRow>();
  }

  /** The workspace's own emoji: guests read them too, so what members react with draws for them; only members add. */
  async listEmoji(a: { workspace: string; viewer: Viewer }): Promise<Result<EmojiList>> {
    const found = await this.visitWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const { workspace } = found.value;
    const [rows, setting] = await Promise.all([
      this.db.prepare("SELECT * FROM custom_emoji WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name").bind(workspace.id).all<EmojiRow>(),
      this.emojiUpload(workspace),
    ]);
    const role = roleOf(a.viewer, a.workspace);
    return ok({
      emoji: await this.toEmoji(a.workspace.toLowerCase(), workspace, rows.results),
      emoji_upload: setting,
      can_upload: mayUpload(setting, role),
      can_manage: role === "owner",
    });
  }

  /** Who may add one: checked against the workspace's setting. */
  private async mayAdd(workspace: Workspace, viewer: Viewer, slug: string): Promise<Result<null>> {
    const setting = await this.emojiUpload(workspace);
    if (!mayUpload(setting, roleOf(viewer, slug))) return fail("forbidden", "Only owners can add emoji in this workspace.");
    return ok(null);
  }

  async addEmoji(a: { workspace: string; viewer: Viewer; name: string; file: EmojiFile }): Promise<Result<CustomEmoji>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const allowed = await this.mayAdd(workspace, a.viewer, a.workspace);
    if (!allowed.ok) return allowed;
    const named = emojiName(a.name);
    if (!named.ok) return fail("invalid", named.message);
    if (await this.liveEmoji(workspace, named.name)) return fail("conflict", `:${named.name}: is already taken.`);
    const bytes = fromBase64(a.file?.data);
    if (!bytes) return fail("invalid", "Choose a PNG, GIF or WebP image of at most 256 KB.");
    const checked = emojiImage(bytes);
    if (!checked.ok) return fail("invalid", checked.message);
    const file = await sha256(bytes);
    // Kept by its hash, so the same image stored twice is one file; its
    // type is the one read from its bytes (usercontent serves only that).
    await this.env.AVATARS.put(`emoji/${file}`, bytes, { metadata: { contentType: checked.image.content_type } });
    const row: EmojiRow = {
      workspace_id: workspace.id,
      name: named.name,
      alias_of: null,
      file,
      content_type: checked.image.content_type,
      bytes: bytes.length,
      created_by: userKey(a.viewer!),
      created_at: now(),
      deleted_at: null,
    };
    const added = await this.insertEmoji(row);
    if (!added.ok) return added;
    const [emoji] = await this.toEmoji(a.workspace.toLowerCase(), workspace, [row]);
    return ok(emoji!);
  }

  private async insertEmoji(row: EmojiRow): Promise<Result<null>> {
    try {
      await this.db
        .prepare("INSERT INTO custom_emoji (workspace_id, name, alias_of, file, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(row.workspace_id, row.name, row.alias_of, row.file, row.content_type, row.bytes, row.created_by, row.created_at)
        .run();
      return ok(null);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `:${row.name}: is already taken.`);
      throw error;
    }
  }

  async aliasEmoji(a: { workspace: string; viewer: Viewer; name: string; target: string }): Promise<Result<CustomEmoji>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const allowed = await this.mayAdd(workspace, a.viewer, a.workspace);
    if (!allowed.ok) return allowed;
    const named = emojiName(a.name);
    if (!named.ok) return fail("invalid", named.message);
    const targetName = String(a.target ?? "")
      .trim()
      .replace(/^:+|:+$/g, "")
      .toLowerCase();
    let target = await this.liveEmoji(workspace, targetName);
    // An alias of an alias names the emoji itself, so removing one never strands another.
    if (target?.alias_of) target = await this.liveEmoji(workspace, target.alias_of);
    if (!target) return fail("not_found", `This workspace has no :${targetName}: emoji.`);
    if (await this.liveEmoji(workspace, named.name)) return fail("conflict", `:${named.name}: is already taken.`);
    const row: EmojiRow = { ...target, name: named.name, alias_of: target.name, created_by: userKey(a.viewer!), created_at: now(), deleted_at: null };
    const added = await this.insertEmoji(row);
    if (!added.ok) return added;
    const [emoji] = await this.toEmoji(a.workspace.toLowerCase(), workspace, [row]);
    return ok(emoji!);
  }

  async removeEmoji(a: { workspace: string; viewer: Viewer; name: string }): Promise<Result<null>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const name = String(a.name ?? "")
      .trim()
      .replace(/^:+|:+$/g, "")
      .toLowerCase();
    const row = await this.liveEmoji(workspace, name);
    if (!row) return fail("not_found", `This workspace has no :${name}: emoji.`);
    if (!mayRemove(row.created_by, userKey(a.viewer!), roleOf(a.viewer, a.workspace))) {
      return fail("forbidden", "Only whoever added an emoji, or an owner, can remove it.");
    }
    // An emoji goes with its aliases; an alias goes alone.
    await this.db
      .prepare("UPDATE custom_emoji SET deleted_at = ?1 WHERE workspace_id = ?2 AND deleted_at IS NULL AND (name = ?3 OR (?4 = 0 AND alias_of = ?3))")
      .bind(now(), workspace.id, row.name, row.alias_of ? 1 : 0)
      .run();
    // Its image goes once nothing live shows it, in any workspace.
    this.defer(
      (async () => {
        const used = await this.db.prepare("SELECT 1 FROM custom_emoji WHERE file = ? AND deleted_at IS NULL LIMIT 1").bind(row.file).first();
        if (!used) await this.env.AVATARS.delete(`emoji/${row.file}`);
      })().catch((error) => console.error("chat could not forget emoji", row.file, error)),
    );
    return ok(null);
  }

  async setEmojiUpload(a: { workspace: string; viewer: Viewer; value: EmojiUpload }): Promise<Result<EmojiUpload>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    if (roleOf(a.viewer, a.workspace) !== "owner") return fail("forbidden", "Only owners can change who adds emoji.");
    if (a.value !== "members" && a.value !== "admins") return fail("invalid", "Choose members or owners.");
    // The same setting as Settings → Chat (`setChatSettings`).
    const set = await this.setChatSettings({ workspace: a.workspace, viewer: a.viewer, change: { emoji_upload: a.value } });
    return set.ok ? ok(set.value.emoji_upload) : set;
  }

  // ── The live socket ─────────────────────────────────────────────────────

  /**
   * `GET /live?workspace=<slug>&channel=<id>`, upgraded to a WebSocket. The
   * viewer comes in CHAT_VIEWER_HEADER, set by the site after checking the
   * session; trusted only because this Worker is reachable through service
   * bindings alone (`workers_dev` is off and it has no routes). Checked
   * like any read, then handed to the channel's room.
   */
  async live(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade\n", { status: 426 });
    }
    let viewer: Viewer = null;
    try {
      viewer = JSON.parse(request.headers.get(CHAT_VIEWER_HEADER) ?? "null") as Viewer;
    } catch {
      viewer = null;
    }
    if (!viewer?.id) return new Response("Sign in to use chat\n", { status: 401 });
    const url = new URL(request.url);
    const channelId = url.searchParams.get("channel") ?? "";
    let slug = (url.searchParams.get("workspace") ?? "").toLowerCase();
    if (!slug) {
      // Not named: whichever of the viewer's workspaces holds the channel.
      const row = await this.db.prepare("SELECT workspace_id FROM channels WHERE id = ?").bind(channelId).first<{ workspace_id: string }>();
      if (row) {
        const theirs = await Promise.all((viewer.workspaces ?? []).map((m) => this.workspace(m.slug)));
        slug = theirs.find((w) => w?.id === row.workspace_id)?.slug.toLowerCase() ?? "";
      }
    }
    const found = await this.place(slug, channelId, viewer, "read");
    if (!found.ok) return new Response(`${found.error.message}\n`, { status: found.error.code === "forbidden" ? 403 : 404 });
    const { workspace, channel } = found.value;
    const who: RoomMember = { channel_id: channel.id, member: await this.profile(slug, workspace, userKey(viewer)) };
    const headers = new Headers(request.headers);
    headers.delete(CHAT_VIEWER_HEADER);
    headers.set(ROOM_MEMBER_HEADER, JSON.stringify(who));
    return this.room(channel.id).fetch(new Request(request.url, { method: "GET", headers }));
  }
}

/** One RPC method's answer. */
async function answer(service: Chat, method: string, args: any): Promise<Response> {
  switch (method) {
    case "sidebar":
      return Response.json(await service.sidebar(args));
    case "activity":
      return Response.json(await service.activity(args));
    case "channel":
      return Response.json(await service.channel(args));
    case "channel_by_name":
      return Response.json(await service.channelByName(args));
    case "browse":
      return Response.json(await service.browse(args));
    case "create_channel":
      return Response.json(await service.createChannel(args));
    case "update_channel":
      return Response.json(await service.updateChannel(args));
    case "chat_settings":
      return Response.json(await service.chatSettings(args));
    case "set_chat_settings":
      return Response.json(await service.setChatSettings(args));
    case "open_dm":
      return Response.json(await service.openDm(args));
    case "join":
      return Response.json(await service.join(args));
    case "leave":
      return Response.json(await service.leave(args));
    case "invite":
      return Response.json(await service.invite(args));
    case "remove_member":
      return Response.json(await service.removeMember(args));
    case "channel_invitations":
      return Response.json(await service.channelInvitations(args));
    case "answer_channel_invitation":
      return Response.json(await service.answerChannelInvitation(args));
    case "request_access":
      return Response.json(await service.requestAccess(args));
    case "answer_access_request":
      return Response.json(await service.answerAccessRequest(args));
    case "messages":
      return Response.json(await service.messages(args));
    case "post":
      return Response.json(await service.post(args));
    case "edit":
      return Response.json(await service.edit(args));
    case "remove":
      return Response.json(await service.remove(args));
    case "mark_read":
      return Response.json(await service.markRead(args));
    case "set_preferences":
      return Response.json(await service.setPreferences(args));
    case "react":
      return Response.json(await service.react(args));
    case "unreact":
      return Response.json(await service.unreact(args));
    case "list_emoji":
      return Response.json(await service.listEmoji(args));
    case "add_emoji":
      return Response.json(await service.addEmoji(args));
    case "alias_emoji":
      return Response.json(await service.aliasEmoji(args));
    case "remove_emoji":
      return Response.json(await service.removeEmoji(args));
    case "set_emoji_upload":
      return Response.json(await service.setEmojiUpload(args));
    case "g1t_dm":
      return Response.json(await service.g1tDm(args));
    case "g1t_reset":
      return Response.json(await service.g1tReset(args));
    case "g1t_retry":
      return Response.json(await service.g1tRetry(args));
    case "g1t_proposal":
      return Response.json(await service.g1tProposal(args));
    case "g1t_stop":
      return Response.json(await service.g1tStop(args));
    case "g1t_clear":
      return Response.json(await service.g1tClear(args));
    default:
      return new Response("Unknown method\n", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/live") {
      return new Chat(env, (work) => ctx.waitUntil(work)).live(request);
    }
    const internal = url.pathname.match(/^\/internal\/([a-z0-9_]+)$/);
    if (request.method === "POST" && internal) {
      // Only g1t's own services (src/internal.ts).
      return internalAnswer(new Chat(env, (work) => ctx.waitUntil(work)), request, internal[1]!);
    }
    const match = url.pathname.match(/^\/rpc\/([a-z0-9_]+)$/);
    if (request.method !== "POST" || !match) return new Response("Not found\n", { status: 404 });
    if (match[1] === "purge_personal_data") return Response.json(await purgePersonalData(env, await request.json()));
    // A replica near the caller when it asks for one (@g1t/contracts d1.ts).
    const opened = openD1(env.DB, request);
    const service = new Chat(Object.create(env, { DB: { value: opened.db } }) as Env, (work) => ctx.waitUntil(work));
    const args = (await request.json().catch(() => ({}))) as any;
    return opened.finish(await answer(service, match[1], args));
  },
} satisfies ExportedHandler<Env>;
