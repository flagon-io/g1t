/**
 * The chat service: a workspace's channels, direct messages, threads and
 * messages. People and agents are members alike. Plan: docs/WORKSPACE.md.
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
  CHAT_MAX_HOPS,
  askerAccess,
  CHAT_VIEWER_HEADER,
  fail,
  identityClient,
  newId,
  ok,
  openD1,
  parsePrincipalKey,
  principalKey,
  workspaceAgentsClient,
  type AgentDelivery,
  type AgentFoundMessage,
  type AgentPostMessage,
  type AskerAccess,
  type Channel,
  type ChannelChange,
  type ChannelDetail,
  type ChannelMember,
  type ChatAudience,
  type ChatLiveEvent,
  type ChatMessage,
  type ChatReaction,
  type CustomEmoji,
  type EmojiFile,
  type EmojiList,
  type EmojiUpload,
  type ChatSettings,
  type ChatSettingsView,
  type ChatSidebar,
  type ChatSidebarEntry,

  type Member,
  type MemberProfile,
  type CardActionResult,
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
  type WorkspaceAgent,
} from "@g1t/contracts";

import { audienceKind, isShared, likePattern, readableBy } from "./audience.ts";
import { MAX_HOPS, addsOrchestrator, chainFor, deliveries, delivery, sender, type Chain } from "./delivery.ts";
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
import { cleanCard } from "./cards.ts";
import { mentionedHandles, mentionsColumn } from "./mentions.ts";
import { AGENT_TYPING_MS, historyOf, historySize, messageBody, meterDay, pageOf, pageSize } from "./messages.ts";
import { GENERAL, MAX_DM_MEMBERS, channelName, dmKey, dmMembers } from "./names.ts";
import { ROOM_MEMBER_HEADER, type ChannelRoom, type RoomMember } from "./room.ts";
import { mayCreateChannel, mayManageChannel, permissionsFor, rowFor, settingsChange, settingsOf, type SettingsRow } from "./settings.ts";
import { dmTitle, sidebarOrder, tally, type UnreadRow } from "./unread.ts";
// Live notifications and counts (services/notify).
import { notifyMessage, notifyMuted, notifyRead } from "./notify.ts";

export { ChannelRoom } from "./room.ts";

// The hop limit here is the one in the contract.
const SAME_HOP_LIMIT: typeof CHAT_MAX_HOPS = MAX_HOPS;
void SAME_HOP_LIMIT;

type Env = {
  DB: D1Database;
  IDENTITY: ServiceBinding;
  AGENTS: ServiceBinding;
  ROOMS: DurableObjectNamespace<ChannelRoom>;
  /** The avatars namespace: custom emoji images, under `emoji/<sha256>`, which the usercontent origin serves. */
  AVATARS: KVNamespace;
  /** Live notifications and unread counts (services/notify); absent, nobody is told. */
  NOTIFY?: ServiceBinding;
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
};

/** What a method found out about the channel it was asked about. */
type Place = { slug: string; workspace: Workspace; channel: ChannelRow; member: MemberRow | null };

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
    created_by: parsePrincipalKey(row.created_by) ?? { kind: "user", id: row.created_by },
    created_at: row.created_at,
    archived_at: row.archived_at,
    last_message_at: row.last_message_at,
  };
}

/** An asker handed back by the agents service, or null when what was sent is not one. */
function cleanAsker(asker: unknown): AskerAccess | null {
  if (!asker || typeof asker !== "object") return null;
  const a = asker as Record<string, unknown>;
  if (typeof a.username !== "string" || !["owner", "member", "outside"].includes(String(a.role))) return null;
  return { username: a.username, role: a.role as AskerAccess["role"], can_write: a.can_write === true };
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

class Chat {
  private readonly workspaces = new Map<string, Promise<Workspace | null>>();
  private readonly people = new Map<string, Promise<Map<string, Member>>>();
  private readonly usernames = new Map<string, string>();
  private readonly agents = new Map<string, WorkspaceAgent | null>();
  private readonly settingsRows = new Map<string, Promise<SettingsRow | null>>();

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
      // Asked as the workspace itself, so it works for agents' calls too.
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

  /** Agents by id; ones the agents service does not know are null. Asked once per request. */
  private async agentsById(ids: string[]): Promise<Map<string, WorkspaceAgent | null>> {
    const wanted = [...new Set(ids)].filter((id) => !this.agents.has(id));
    if (wanted.length) {
      let found: WorkspaceAgent[] = [];
      try {
        found = await workspaceAgentsClient(this.env.AGENTS).byIds(wanted);
      } catch (error) {
        console.error("chat could not resolve agents", error);
      }
      for (const id of wanted) this.agents.set(id, found.find((a) => a.id === id) ?? null);
    }
    return new Map(ids.map((id) => [id, this.agents.get(id) ?? null]));
  }

  /** An agent of this workspace that is not archived, or null. */
  private async liveAgent(workspace: Workspace, id: string): Promise<WorkspaceAgent | null> {
    const agent = (await this.agentsById([id])).get(id) ?? null;
    return agent && agent.workspace_id === workspace.id && !agent.archived_at ? agent : null;
  }

  /** How each member key shows, for one workspace. */
  private async profiles(slug: string, workspace: Workspace, keys: string[]): Promise<Map<string, MemberProfile>> {
    const principals = [...new Set(keys)].map((key) => parsePrincipalKey(key)).filter((p): p is Principal => !!p);
    const userIds = principals.filter((p) => p.kind === "user").map((p) => p.id);
    const agentIds = principals.filter((p) => p.kind === "agent").map((p) => p.id);
    const unnamed = userIds.filter((id) => !this.usernames.has(id));
    const [named, people, agents] = await Promise.all([
      unnamed.length ? identityClient(this.env.IDENTITY).usernames(unnamed).catch(() => ({}) as Record<string, string>) : ({} as Record<string, string>),
      userIds.length ? this.members(slug, workspace) : new Map<string, Member>(),
      this.agentsById(agentIds),
    ]);
    for (const [id, username] of Object.entries(named)) this.usernames.set(id, username);
    const out = new Map<string, MemberProfile>();
    for (const p of principals) {
      if (p.kind === "user") {
        const username = this.usernames.get(p.id) ?? null;
        const person = username ? people.get(username) : undefined;
        out.set(principalKey(p), {
          ...p,
          name: username ?? "ghost",
          display_username: person?.display_username ?? null,
          // Their display name, else their username as they wrote it
          // (`memberName` reads this the same way).
          display_name: person?.name?.trim() || person?.display_username || username || "Former member",
          avatar: person?.avatar ?? null,
          role: null,
          title: null,
          avatar_seed: null,
        });
      } else {
        const agent = agents.get(p.id) ?? null;
        out.set(principalKey(p), {
          ...p,
          name: agent?.handle ?? p.id,
          display_name: agent?.display_name ?? "Former agent",
          avatar: agent?.avatar ?? null,
          role: agent?.role ?? null,
          title: agent?.title || null,
          avatar_seed: agent?.avatar_seed ?? null,
        });
      }
    }
    return out;
  }

  private async profile(slug: string, workspace: Workspace, key: string): Promise<MemberProfile> {
    return (await this.profiles(slug, workspace, [key])).get(key)!;
  }

  /** Whether `principal` may be added to a conversation in this workspace. */
  private async belongs(slug: string, workspace: Workspace, principal: Principal): Promise<boolean> {
    if (principal.kind === "agent") return !!(await this.liveAgent(workspace, principal.id));
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
   * A channel the viewer may read (`read`: any public one in their
   * workspace, or one they are in) or write in (`member`: one they are in).
   * A private channel or direct message they are not in is not found, so
   * its existence does not leak.
   */
  private async place(
    slug: string,
    channelId: string,
    viewer: Viewer,
    need: "read" | "member",
  ): Promise<Result<Place>> {
    const found = await this.viewerWorkspace(slug, viewer);
    if (!found.ok) return found;
    const workspace = found.value;
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
    const open = channel.kind === "channel" && !channel.private;
    if (!member && !open) return fail("not_found", "No such channel.");
    if (!member && need === "member") return fail("forbidden", `Join #${channel.name} first.`);
    return ok({ slug: slug.toLowerCase(), workspace, channel, member });
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
    const reactions = await this.reactionsOf(rows.filter((r) => !r.deleted_at).map((r) => r.id), me);
    const reactors = [...reactions.values()].flatMap((list) => list.flatMap((r) => r.by));
    const profiles = await this.profiles(slug, workspace, [...rows.map((r) => r.author), ...reactors]);
    return rows.map((row) => {
      const gone = !!row.deleted_at;
      return {
        reactions: gone
          ? []
          : (reactions.get(row.id) ?? []).map((r) => ({ ...r, by: r.by.map((key) => profiles.get(key)!).filter(Boolean) })),
        id: row.id,
        channel_id: row.channel_id,
        author: profiles.get(row.author)!,
        kind: row.kind,
        body: gone ? "" : row.body,
        card: gone || !row.card ? null : (JSON.parse(row.card) as MessageCard),
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
      .prepare(
        "SELECT message_id, emoji, principal, created_at FROM reactions WHERE message_id IN (SELECT value FROM json_each(?))",
      )
      .bind(JSON.stringify(ids))
      .all<ReactionRow>();
    return tallyReactions(rows.results, me);
  }

  private async messageRow(channelId: string, id: string): Promise<MessageRow | null> {
    return this.db.prepare("SELECT * FROM messages WHERE id = ? AND channel_id = ?").bind(String(id ?? ""), channelId).first<MessageRow>();
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
    const seen = await this.db
      .prepare("SELECT 1 FROM general_joined WHERE workspace_id = ? AND principal = ?")
      .bind(workspace.id, me)
      .first();
    if (seen) return;
    const at = now();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO channels (id, workspace_id, kind, name, topic, private, created_by, created_at) VALUES (?, ?, 'channel', ?, ?, 0, ?, ?)",
      )
      .bind(newId("chn"), workspace.id, GENERAL, "Anything and everything for the whole workspace.", me, at)
      .run();
    const general = await this.db
      .prepare("SELECT * FROM channels WHERE workspace_id = ? AND name = ?")
      .bind(workspace.id, GENERAL)
      .first<ChannelRow>();
    const statements = [
      this.db
        .prepare("INSERT OR IGNORE INTO general_joined (workspace_id, principal, joined_at) VALUES (?, ?, ?)")
        .bind(workspace.id, me, at),
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

  async sidebar(a: { workspace: string; viewer: Viewer }): Promise<Result<ChatSidebar>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const slug = a.workspace.toLowerCase();
    const me = userKey(a.viewer!);
    await this.ensureGeneral(workspace, me);

    const [joined, unread, dmOthers, browsable] = await Promise.all([
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
             AND NOT EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.principal = ?)`,
        )
        .bind(workspace.id, me)
        .first<{ n: number }>(),
    ]);

    const others = new Map<string, string[]>();
    for (const row of dmOthers.results) others.set(row.channel_id, [...(others.get(row.channel_id) ?? []), row.principal]);
    const profiles = await this.profiles(slug, workspace, [me, ...dmOthers.results.map((r) => r.principal)]);
    const self = profiles.get(me) ?? null;
    const counts = tally(
      unread.results,
      me,
      self?.name ?? a.viewer!.username,
      new Map(joined.results.map((row) => [row.id, row.last_read_id])),
    );

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
    return ok({ entries: sidebarOrder(entries), browsable: browsable?.n ?? 0, can: permissionsFor(settings, roleOf(a.viewer, slug)) });
  }

  // ── Channels ────────────────────────────────────────────────────────────

  async channel(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<ChannelDetail>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { slug, workspace, channel, member } = found.value;
    const [rows, settings] = await Promise.all([
      this.db
        .prepare("SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at, principal")
        .bind(channel.id)
        .all<MemberRow>(),
      this.settings(workspace),
    ]);
    const profiles = await this.profiles(slug, workspace, rows.results.map((r) => r.principal));
    return ok({
      channel: toChannel(channel),
      can_manage: channel.kind === "channel" && mayManageChannel(settings, roleOf(a.viewer, slug), member?.role ?? null),
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
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const named = channelName(a.name ?? "");
    if (!named.ok) return fail("not_found", "No such channel.");
    const row = await this.db
      .prepare("SELECT id FROM channels WHERE workspace_id = ? AND name = ?")
      .bind(found.value.id, named.name)
      .first<{ id: string }>();
    if (!row) return fail("not_found", "No such channel.");
    // A private channel the viewer is not in stays not found there.
    return this.channel({ workspace: a.workspace, channel_id: row.id, viewer: a.viewer });
  }

  /**
   * Every public channel, and the private ones the viewer is in; a private
   * one they are not in stays unseen. With `archived`, the archived ones.
   */
  async browse(a: { workspace: string; viewer: Viewer; archived?: boolean }): Promise<Result<Channel[]>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const rows = await this.db
      .prepare(
        `SELECT * FROM channels c
         WHERE c.workspace_id = ?1 AND c.kind = 'channel'
           AND (c.archived_at IS NULL) = (?3 = 0)
           AND (c.private = 0 OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.principal = ?2))
         ORDER BY c.name`,
      )
      .bind(found.value.id, userKey(a.viewer!), a.archived === true ? 1 : 0)
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
    const isPrivate = !!a.input?.private;
    if (!mayCreateChannel(await this.settings(workspace), roleOf(a.viewer, a.workspace), isPrivate)) {
      return fail("forbidden", `Only owners can create ${isPrivate ? "private" : "public"} channels in this workspace.`);
    }
    const taken = await this.db
      .prepare("SELECT 1 FROM channels WHERE workspace_id = ? AND name = ?")
      .bind(workspace.id, named.name)
      .first();
    if (taken) return fail("conflict", `#${named.name} already exists.`);
    const me = userKey(a.viewer!);
    const row: ChannelRow = {
      id: newId("chn"),
      workspace_id: workspace.id,
      kind: "channel",
      name: named.name,
      topic: topic || null,
      private: isPrivate ? 1 : 0,
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
            "INSERT INTO channels (id, workspace_id, kind, name, topic, private, created_by, created_at) VALUES (?, ?, 'channel', ?, ?, ?, ?, ?)",
          )
          .bind(row.id, row.workspace_id, row.name, row.topic, row.private, me, row.created_at),
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
      if (!p) return fail("invalid", "Each member is a person or an agent, by id.");
      principals.push(p);
    }
    const members = dmMembers(me, principals.map(principalKey));
    if (members.length > MAX_DM_MEMBERS) {
      return fail("invalid", `A direct message has at most ${MAX_DM_MEMBERS} people and agents. Make a private channel instead.`);
    }
    const key = dmKey(members);
    const existing = await this.db
      .prepare("SELECT * FROM channels WHERE workspace_id = ? AND dm_key = ?")
      .bind(workspace.id, key)
      .first<ChannelRow>();
    if (existing) return ok(toChannel(existing));

    for (const member of members) {
      if (member === me) continue;
      const p = parsePrincipalKey(member)!;
      if (!(await this.belongs(slug, workspace, p))) {
        return fail("not_found", p.kind === "agent" ? "No such agent in this workspace." : "That person is not in this workspace.");
      }
    }
    const at = now();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO channels (id, workspace_id, kind, private, dm_key, created_by, created_at) VALUES (?, ?, 'dm', 1, ?, ?, ?)",
      )
      .bind(newId("chn"), workspace.id, key, me, at)
      .run();
    // Read back by key: if two people opened it at once, both get the one that won.
    const channel = await this.db
      .prepare("SELECT * FROM channels WHERE workspace_id = ? AND dm_key = ?")
      .bind(workspace.id, key)
      .first<ChannelRow>();
    if (!channel) return fail("conflict", "The direct message could not be opened. Try again.");
    await this.db.batch(members.map((member) => this.joinStatement(channel.id, member, "member", at)));
    return ok(toChannel(channel));
  }

  async join(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { channel, member } = found.value;
    if (member) return ok(null);
    if (channel.archived_at) return fail("invalid", "This channel is archived.");
    await this.joinStatement(channel.id, userKey(a.viewer!), "member", now()).run();
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
      this.defer(this.room(channel.id).drop(me).catch((error: unknown) => console.error("chat could not drop", me, error)));
    }
    return ok(null);
  }

  async invite(a: { workspace: string; channel_id: string; viewer: Viewer; member: Principal }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "member");
    if (!found.ok) return found;
    const { slug, workspace, channel } = found.value;
    if (channel.kind === "dm") return fail("invalid", "People can't be added to a direct message. Start a new one with everyone in it.");
    if (channel.archived_at) return fail("invalid", "This channel is archived.");
    const p = a.member && parsePrincipalKey(`${a.member.kind}:${a.member.id}`);
    if (!p) return fail("invalid", "Invite a person or an agent, by id.");
    if (!(await this.belongs(slug, workspace, p))) {
      return fail("not_found", p.kind === "agent" ? "No such agent in this workspace." : "That person is not in this workspace.");
    }
    await this.joinStatement(channel.id, principalKey(p), "member", now()).run();
    return ok(null);
  }

  async setPreferences(a: {
    workspace: string;
    channel_id: string;
    viewer: Viewer;
    prefs: { starred?: boolean; muted?: boolean };
  }): Promise<Result<null>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "member");
    if (!found.ok) return found;
    const starred = typeof a.prefs?.starred === "boolean" ? (a.prefs.starred ? 1 : 0) : null;
    const muted = typeof a.prefs?.muted === "boolean" ? (a.prefs.muted ? 1 : 0) : null;
    await this.db
      .prepare(
        "UPDATE channel_members SET starred = COALESCE(?, starred), muted = COALESCE(?, muted) WHERE channel_id = ? AND principal = ?",
      )
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
    const { slug, workspace, channel, member } = found.value;
    if (channel.kind === "dm") return fail("invalid", "A direct message has no name or topic to change.");
    const change = a.change ?? {};
    const next: ChannelRow = { ...channel };
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
        .prepare("UPDATE channels SET name = ?, topic = ?, archived_at = ? WHERE id = ?")
        .bind(next.name, next.topic, next.archived_at, channel.id)
        .run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `#${next.name} already exists.`);
      throw error;
    }
    const updated = toChannel(next);
    this.broadcast(channel.id, { type: "channel.updated", channel: updated });
    return ok(updated);
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
    // so a session's card stays at the top of its thread.
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
   * the meter; then, after answering, tells the room and wakes the agents
   * it is for.
   */
  private async write(
    place: Place,
    author: string,
    input: { body: string; card: MessageCard | null; thread_root: string | null },
    chain: Chain<AskerAccess>,
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
    const handles = mentionedHandles(input.body);
    const row: MessageRow = {
      id: newId("msg"),
      channel_id: channel.id,
      author,
      kind: input.card ? "card" : "text",
      body: input.body,
      card: input.card ? JSON.stringify(input.card) : null,
      mentions: mentionsColumn(handles),
      thread_root: threadRoot,
      reply_count: 0,
      last_reply_at: null,
      created_at: at,
      edited_at: null,
      deleted_at: null,
    };
    const statements = [
      this.db
        .prepare(
          "INSERT INTO messages (id, channel_id, author, kind, body, card, mentions, thread_root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(row.id, row.channel_id, author, row.kind, row.body, row.card, row.mentions, threadRoot, at),
      this.db.prepare("UPDATE channels SET last_message_at = ? WHERE id = ?").bind(at, channel.id),
      // What you wrote, you have read.
      this.db
        .prepare("UPDATE channel_members SET last_read_id = ? WHERE channel_id = ? AND principal = ?")
        .bind(row.id, channel.id, author),
      this.db
        .prepare(
          `INSERT INTO chat_meter (workspace_id, day, messages, bytes) VALUES (?, ?, 1, ?)
           ON CONFLICT (workspace_id, day) DO UPDATE SET messages = messages + 1, bytes = bytes + excluded.bytes`,
        )
        .bind(workspace.id, meterDay(at), bytesOf(row.body) + bytesOf(row.card ?? "")),
    ];
    if (threadRoot) {
      statements.push(
        this.db
          .prepare("UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?")
          .bind(at, threadRoot),
      );
    }
    await this.db.batch(statements);

    const [message] = await this.toMessages(place.slug, workspace, [row]);
    this.broadcast(channel.id, { type: "message.created", message });
    if (threadRoot) this.rebroadcast(place, threadRoot);
    this.defer(
      this.wake(place, row, handles, chain).catch((error) => console.error("chat could not hand", row.id, "to agents", error)),
    );
    // Notify: counts for everyone in the conversation, a notification for those it is for.
    this.defer(
      notifyMessage(this.db, this.env.NOTIFY, (keys) => this.profiles(place.slug, workspace, keys), { slug: place.slug, channel, row, handles, asked_by: chain.asked_by }).catch(
        (error) => console.error("chat could not notify about", row.id, error),
      ),
    );
    return ok(message);
  }

  /** Hands a new message to the agents it is for (src/delivery.ts). */
  private async wake(place: Place, row: MessageRow, handles: string[], chain: Chain<AskerAccess>): Promise<void> {
    const { channel, workspace } = place;
    // Only an agent's message mentioning someone, or a person's, can wake anyone.
    if (row.author.startsWith("agent:") && !handles.length) return;
    if (channel.kind === "channel" && !handles.length) return;
    const members = await this.db
      .prepare("SELECT principal FROM channel_members WHERE channel_id = ? AND principal LIKE 'agent:%'")
      .bind(channel.id)
      .all<{ principal: string }>();
    const ids = members.results.map((m) => m.principal.slice("agent:".length));
    let found = await this.agentsById(ids);
    const orchestratorIsMember = [...found.values()].some((agent) => !!agent?.builtin && agent.workspace_id === workspace.id && !agent.archived_at);
    if (addsOrchestrator({ channelKind: channel.kind, mentioned: handles, orchestratorIsMember })) {
      // Mentioning @g1t brings it in: every workspace has it, nobody invites it.
      const builtin = await workspaceAgentsClient(this.env.AGENTS)
        .builtin(place.slug, workspace.id)
        .catch((error: unknown) => {
          console.error("chat could not find @g1t for", place.slug, error);
          return null;
        });
      if (builtin?.ok) {
        await this.joinStatement(channel.id, `agent:${builtin.value.id}`, "member", now()).run();
        this.agents.set(builtin.value.id, builtin.value);
        ids.push(builtin.value.id);
        found = await this.agentsById(ids);
      }
    }
    if (!ids.length) return;
    const agents = [...found.values()].filter(
      (agent): agent is WorkspaceAgent => !!agent && agent.workspace_id === workspace.id && !agent.archived_at,
    );
    const wakes = deliveries({
      author: row.author,
      hops: chain.hops,
      channelKind: channel.kind,
      agents: agents.map((agent) => ({ id: agent.id, handle: agent.handle })),
      mentioned: handles,
      notTo: sender(chain.chain),
    });
    const client = workspaceAgentsClient(this.env.AGENTS);
    await Promise.all(
      wakes.map((wake) =>
        client
          .deliver(
            delivery(
              {
                workspace: place.slug,
                workspace_id: workspace.id,
                channel_id: channel.id,
                channel_kind: channel.kind,
                channel_name: channel.kind === "dm" ? null : channel.name,
              },
              wake,
              row,
              chain,
            ) satisfies AgentDelivery,
          )
          .then((result) => {
            if (!result.ok) console.error("agents refused delivery to", wake.agent_id, result.error.message);
          })
          .catch((error) => console.error("chat could not deliver to", wake.agent_id, error)),
      ),
    );
  }

  async post(a: { workspace: string; channel_id: string; viewer: Viewer; message: PostMessage }): Promise<Result<ChatMessage>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const body = messageBody(a.message?.body);
    if (!body.ok) return fail("invalid", body.message);
    const me = userKey(a.viewer!);
    let place = found.value;
    if (!place.member) {
      // Saying something in a public channel joins it, as reading does not.
      if (place.channel.archived_at) return fail("invalid", "This channel is archived.");
      await this.joinStatement(place.channel.id, me, "member", now()).run();
      place = { ...place, member: { channel_id: place.channel.id, principal: me } as MemberRow };
    }
    return this.write(
      place,
      me,
      { body: body.body, card: null, thread_root: a.message?.thread_root ?? null },
      // A person's message starts a chain.
      { hops: 0, asked_by: a.viewer!.id, asker: askerAccess(a.viewer!, a.workspace), chain: [] },
    );
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
    await this.db
      .prepare("UPDATE messages SET body = ?, mentions = ?, edited_at = ? WHERE id = ?")
      .bind(body.body, mentions, at, row.id)
      .run();
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
    if (row.author !== userKey(a.viewer!) && !isOwner(a.viewer, a.workspace)) {
      return fail("forbidden", "Only its author or a workspace owner can delete a message.");
    }
    const statements = [
      this.db
        .prepare("UPDATE messages SET deleted_at = ?, body = '', card = NULL, mentions = '' WHERE id = ?")
        .bind(now(), row.id),
    ];
    if (row.thread_root) {
      statements.push(
        this.db.prepare("UPDATE messages SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?").bind(row.thread_root),
      );
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
      .prepare(
        "UPDATE channel_members SET last_read_id = ?1 WHERE channel_id = ?2 AND principal = ?3 AND (last_read_id IS NULL OR last_read_id < ?1)",
      )
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
        notifyRead(this.db, this.env.NOTIFY, { slug: found.value.slug, channel_id: channel.id, user_id: a.viewer!.id, username: a.viewer!.username, last_read_id: id }).catch(
          (error) => console.error("chat could not notify a read", error),
        ),
      );
    }
    return ok(null);
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  /** The channel and agent for an agent's call: the agent must be of the workspace and in the channel. */
  private async agentPlace(slug: string, channelId: string, agentId: string): Promise<Result<{ place: Place; agent: WorkspaceAgent }>> {
    const workspace = await this.workspace(String(slug ?? ""));
    if (!workspace) return fail("not_found", "No such workspace.");
    const agent = await this.liveAgent(workspace, String(agentId ?? ""));
    if (!agent) return fail("not_found", "No such agent in this workspace.");
    const key = principalKey({ kind: "agent", id: agent.id });
    const [channel, member] = await Promise.all([
      this.db
        .prepare("SELECT * FROM channels WHERE id = ? AND workspace_id = ?")
        .bind(String(channelId ?? ""), workspace.id)
        .first<ChannelRow>(),
      this.db.prepare("SELECT * FROM channel_members WHERE channel_id = ? AND principal = ?").bind(String(channelId ?? ""), key).first<MemberRow>(),
    ]);
    if (!channel) return fail("not_found", "No such channel.");
    if (!member) return fail("forbidden", "The agent is not a member of this channel.");
    return ok({ place: { slug: slug.toLowerCase(), workspace, channel, member }, agent });
  }

  async postAsAgent(a: { workspace: string; channel_id: string; agent_id: string; message: AgentPostMessage }): Promise<Result<ChatMessage>> {
    const found = await this.agentPlace(a.workspace, a.channel_id, a.agent_id);
    if (!found.ok) return found;
    const { place, agent } = found.value;
    const card = a.message?.card == null ? null : cleanCard(a.message.card);
    if (a.message?.card != null && !card) return fail("invalid", "A card needs a kind and a title.");
    const body = messageBody(a.message?.body ?? "", !!card);
    if (!body.ok) return fail("invalid", body.message);
    const hops = typeof a.message?.hops === "number" && a.message.hops >= 0 ? Math.floor(a.message.hops) : 0;
    const askedBy = typeof a.message?.asked_by === "string" && a.message.asked_by ? a.message.asked_by : agent.created_by;
    return this.write(
      place,
      principalKey({ kind: "agent", id: agent.id }),
      { body: body.body, card, thread_root: a.message?.thread_root ?? null },
      // The asker carries on from the delivery the agent is answering;
      // without one, agents it wakes treat the asker as unable to change code.
      { hops, asked_by: askedBy, asker: cleanAsker(a.message?.asker), chain: chainFor(a.message?.chain, agent.id) },
    );
  }

  /**
   * A person presses an action on a card. They must be able to read the
   * conversation; the card must offer the action; its owner (agents)
   * decides whether this person may, does it, and updates the card.
   */
  async cardAction(a: {
    workspace: string;
    channel_id: string;
    viewer: Viewer;
    message_id: string;
    action_id: string;
    input?: string | null;
  }): Promise<Result<CardActionResult>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const place = found.value;
    const row = await this.messageRow(place.channel.id, String(a.message_id ?? ""));
    if (!row || row.deleted_at || !row.card) return fail("not_found", "No such card.");
    const card = JSON.parse(row.card) as MessageCard;
    const action = card.actions?.find((x) => x.id === a.action_id);
    if (!action || action.href || card.owner !== "agents") return fail("invalid", "That card has no such action.");
    const input = typeof a.input === "string" ? a.input.slice(0, 4000) : null;
    if (action.input && !input?.trim()) return fail("invalid", `${action.input.label || "A value"} is needed.`);
    return workspaceAgentsClient(this.env.AGENTS).cardAction({
      workspace: place.slug,
      channel_id: place.channel.id,
      message_id: row.id,
      viewer: a.viewer!,
      card: { kind: card.kind, ref: card.ref ?? null },
      action_id: action.id,
      input,
    });
  }

  /**
   * Changes a message the agent posted (a session's live card, say): its
   * body, its card, or both. Only the agent's own messages; it wakes
   * nobody, and everyone in the conversation sees it change.
   */
  async updateAsAgent(a: {
    workspace: string;
    channel_id: string;
    agent_id: string;
    id: string;
    change: { body?: string; card?: MessageCard | null };
  }): Promise<Result<ChatMessage>> {
    const found = await this.agentPlace(a.workspace, a.channel_id, a.agent_id);
    if (!found.ok) return found;
    const { place, agent } = found.value;
    const row = await this.messageRow(place.channel.id, String(a.id ?? ""));
    if (!row || row.deleted_at) return fail("not_found", "No such message.");
    if (row.author !== principalKey({ kind: "agent", id: agent.id })) return fail("forbidden", "An agent can change only its own messages.");
    const change = a.change ?? {};
    const card = change.card === undefined ? (row.card ? (JSON.parse(row.card) as MessageCard) : null) : change.card === null ? null : cleanCard(change.card);
    if (change.card && !card) return fail("invalid", "A card needs a kind and a title.");
    const body = messageBody(change.body === undefined ? row.body : change.body, !!card);
    if (!body.ok) return fail("invalid", body.message);
    const cardJson = card ? JSON.stringify(card) : null;
    const at = now();
    // A card's live state is not an edit a person made: no "edited" mark for it.
    const edited = change.body !== undefined && change.body !== row.body ? at : row.edited_at;
    await this.db
      .prepare("UPDATE messages SET body = ?, card = ?, kind = ?, edited_at = ? WHERE id = ?")
      .bind(body.body, cardJson, card ? "card" : "text", edited, row.id)
      .run();
    const [message] = await this.toMessages(place.slug, place.workspace, [{ ...row, body: body.body, card: cardJson, kind: card ? "card" : "text", edited_at: edited }]);
    this.broadcast(place.channel.id, { type: "message.updated", message });
    return ok(message);
  }

  /**
   * What an agent reads before replying, oldest first: a thread (its root,
   * then its latest replies), or the channel's latest top-level messages.
   * Only where the agent is a member, so it reads only what was said where
   * it was invited. Deleted messages are left out, save a thread's root.
   */
  async historyForAgent(a: {
    workspace: string;
    channel_id: string;
    agent_id: string;
    thread_root?: string | null;
    limit?: number | null;
  }): Promise<Result<ChatMessage[]>> {
    const found = await this.agentPlace(a.workspace, a.channel_id, a.agent_id);
    if (!found.ok) return found;
    const { place } = found.value;
    const size = historySize(a.limit);
    if (typeof a.thread_root === "string" && a.thread_root) {
      const asked = await this.messageRow(place.channel.id, a.thread_root);
      if (!asked) return fail("not_found", "No such thread.");
      // Asked from a reply: its whole thread.
      const root = asked.thread_root ? await this.messageRow(place.channel.id, asked.thread_root) : asked;
      if (!root) return fail("not_found", "No such thread.");
      const replies = await this.db
        .prepare(
          "SELECT * FROM messages WHERE thread_root = ? AND channel_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?",
        )
        .bind(root.id, place.channel.id, Math.max(0, size - 1))
        .all<MessageRow>();
      return ok(await this.toMessages(place.slug, place.workspace, historyOf(replies.results, root)));
    }
    const rows = await this.db
      .prepare(
        "SELECT * FROM messages WHERE channel_id = ? AND thread_root IS NULL AND id < '~' AND deleted_at IS NULL ORDER BY id DESC LIMIT ?",
      )
      .bind(place.channel.id, size)
      .all<MessageRow>();
    return ok(await this.toMessages(place.slug, place.workspace, historyOf(rows.results)));
  }

  // ── What an agent may read (src/audience.ts) ───────────────────────────

  /** The people in a conversation, by user id. */
  private async peopleIn(channelId: string): Promise<string[]> {
    const rows = await this.db
      .prepare("SELECT principal FROM channel_members WHERE channel_id = ? AND principal LIKE 'user:%'")
      .bind(channelId)
      .all<{ principal: string }>();
    return rows.results.map((row) => row.principal.slice("user:".length));
  }

  /** A conversation of this workspace and who reads it, worked out here, never taken from a caller. */
  private async audienceOf(slug: string, channelId: string): Promise<Result<{ workspace: Workspace; channel: ChannelRow; audience: ChatAudience }>> {
    const workspace = await this.workspace(String(slug ?? "").toLowerCase());
    if (!workspace) return fail("not_found", "No such workspace.");
    const channel = await this.db
      .prepare("SELECT * FROM channels WHERE id = ? AND workspace_id = ?")
      .bind(String(channelId ?? ""), workspace.id)
      .first<ChannelRow>();
    if (!channel) return fail("not_found", "No such conversation.");
    const people = await this.peopleIn(channel.id);
    return ok({ workspace, channel, audience: { kind: audienceKind(channel), member_user_ids: people, member_count: people.length } });
  }

  async audience(a: { workspace: string; channel_id: string }): Promise<Result<ChatAudience>> {
    const found = await this.audienceOf(a.workspace, a.channel_id);
    return found.ok ? ok(found.value.audience) : found;
  }

  /**
   * The conversations of the workspace the audience of `channelId` may all
   * read: public channels, and the ones every person in it is in (a DM only
   * with exactly them). At most 500, most recently active first.
   */
  private async readableFor(workspace: Workspace, audience: ChatAudience): Promise<Map<string, ChannelRow>> {
    const people = audience.member_user_ids;
    const rows = isShared({ kind: audience.kind, user_ids: people }) || !people.length
      ? await this.db
          .prepare("SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND private = 0 ORDER BY last_message_at DESC LIMIT 500")
          .bind(workspace.id)
          .all<ChannelRow>()
      : await this.db
          .prepare(
            `SELECT * FROM channels WHERE workspace_id = ?1 AND (
               (kind = 'channel' AND private = 0)
               OR id IN (SELECT channel_id FROM channel_members WHERE principal IN (${people.map((_, i) => `?${i + 2}`).join(", ")})
                         GROUP BY channel_id HAVING COUNT(DISTINCT principal) = ${people.length})
             ) ORDER BY last_message_at DESC LIMIT 500`,
          )
          .bind(workspace.id, ...people.map((id) => `user:${id}`))
          .all<ChannelRow>();
    const out = new Map<string, ChannelRow>();
    for (const channel of rows.results) {
      // The query finds candidates; the rule decides, a DM's people included.
      const target = { kind: channel.kind, private: channel.private, user_ids: channel.kind === "channel" && !channel.private ? [] : await this.peopleIn(channel.id) };
      if (readableBy(target, { kind: audience.kind, user_ids: people })) out.set(channel.id, channel);
    }
    return out;
  }

  private async found(slug: string, workspace: Workspace, channels: Map<string, ChannelRow>, rows: MessageRow[]): Promise<AgentFoundMessage[]> {
    const messages = await this.toMessages(slug, workspace, rows);
    return messages.map((message) => {
      const channel = channels.get(message.channel_id)!;
      return { channel_id: channel.id, channel: channel.kind === "dm" ? null : channel.name, message };
    });
  }

  async searchForAgent(a: { workspace: string; channel_id: string; query: string; limit?: number | null }): Promise<Result<AgentFoundMessage[]>> {
    const found = await this.audienceOf(a.workspace, a.channel_id);
    if (!found.ok) return found;
    const pattern = likePattern(a.query);
    if (!pattern) return fail("invalid", "Search for at least two characters.");
    const { workspace, audience } = found.value;
    const channels = await this.readableFor(workspace, audience);
    if (!channels.size) return ok([]);
    const ids = [...channels.keys()];
    const limit = Math.min(20, Math.max(1, Math.floor(Number(a.limit) || 20)));
    const rows = await this.db
      .prepare(
        `SELECT * FROM messages WHERE channel_id IN (${ids.map(() => "?").join(", ")}) AND deleted_at IS NULL AND body LIKE ? ESCAPE '\\'
         ORDER BY id DESC LIMIT ?`,
      )
      .bind(...ids, pattern, limit)
      .all<MessageRow>();
    return ok(await this.found(a.workspace.toLowerCase(), workspace, channels, rows.results));
  }

  async threadForAgent(a: { workspace: string; channel_id: string; target_channel_id: string; id: string }): Promise<Result<AgentFoundMessage[]>> {
    const found = await this.audienceOf(a.workspace, a.channel_id);
    if (!found.ok) return found;
    const { workspace, audience } = found.value;
    // The same answer for a conversation that is not there and one the audience may not read.
    const hidden = fail("not_found", "Not available in this conversation.");
    const target = await this.db
      .prepare("SELECT * FROM channels WHERE id = ? AND workspace_id = ?")
      .bind(String(a.target_channel_id ?? ""), workspace.id)
      .first<ChannelRow>();
    if (!target) return hidden;
    const people = target.kind === "channel" && !target.private ? [] : await this.peopleIn(target.id);
    if (!readableBy({ kind: target.kind, private: target.private, user_ids: people }, { kind: audience.kind, user_ids: audience.member_user_ids })) return hidden;
    const asked = await this.messageRow(target.id, String(a.id ?? ""));
    if (!asked) return hidden;
    const root = asked.thread_root ? await this.messageRow(target.id, asked.thread_root) : asked;
    if (!root) return hidden;
    const replies = await this.db
      .prepare("SELECT * FROM messages WHERE thread_root = ? AND channel_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 49")
      .bind(root.id, target.id)
      .all<MessageRow>();
    const rows = historyOf(replies.results, root).filter((row) => !row.deleted_at);
    return ok(await this.found(a.workspace.toLowerCase(), workspace, new Map([[target.id, target]]), rows));
  }

  async agentTyping(a: { workspace: string; channel_id: string; agent_id: string }): Promise<Result<null>> {
    const found = await this.agentPlace(a.workspace, a.channel_id, a.agent_id);
    if (!found.ok) return found;
    const { place, agent } = found.value;
    const key = principalKey({ kind: "agent", id: agent.id });
    const member = await this.profile(place.slug, place.workspace, key);
    this.broadcast(place.channel.id, {
      type: "typing",
      channel_id: place.channel.id,
      member,
      until: new Date(Date.now() + AGENT_TYPING_MS).toISOString(),
    });
    return ok(null);
  }

  // ── Reactions (src/emoji.ts) ────────────────────────────────────────────

  /** One message's reactions now, as `me` sees them. */
  private async reactionsFor(place: Place, messageId: string, me: string): Promise<ChatReaction[]> {
    const list = (await this.reactionsOf([messageId], me)).get(messageId) ?? [];
    const profiles = await this.profiles(place.slug, place.workspace, list.flatMap((r) => r.by));
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
      const done = await this.db
        .prepare("DELETE FROM reactions WHERE message_id = ? AND principal = ? AND emoji = ?")
        .bind(row.id, who, parsed.emoji)
        .run();
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

  /** An agent's reaction counts like anyone's; it must be in the channel. */
  async reactAsAgent(a: {
    workspace: string;
    channel_id: string;
    agent_id: string;
    message_id: string;
    emoji: string;
    remove?: boolean;
  }): Promise<Result<ChatReaction[]>> {
    const found = await this.agentPlace(a.workspace, a.channel_id, a.agent_id);
    if (!found.ok) return found;
    const { place, agent } = found.value;
    return this.reactTo(place, principalKey({ kind: "agent", id: agent.id }), a.message_id, a.emoji, a.remove === true);
  }

  // ── A workspace's own emoji (src/emoji.ts) ──────────────────────────────

  private async emojiUpload(workspace: Workspace): Promise<EmojiUpload> {
    return settingsOf(await this.settingsRow(workspace)).emoji_upload;
  }

  private async toEmoji(slug: string, workspace: Workspace, rows: EmojiRow[]): Promise<CustomEmoji[]> {
    const profiles = await this.profiles(slug, workspace, rows.map((r) => r.created_by));
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
    return this.db
      .prepare("SELECT * FROM custom_emoji WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL")
      .bind(workspace.id, name)
      .first<EmojiRow>();
  }

  async listEmoji(a: { workspace: string; viewer: Viewer }): Promise<Result<EmojiList>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const workspace = found.value;
    const [rows, setting] = await Promise.all([
      this.db
        .prepare("SELECT * FROM custom_emoji WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name")
        .bind(workspace.id)
        .all<EmojiRow>(),
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
        .prepare(
          "INSERT INTO custom_emoji (workspace_id, name, alias_of, file, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
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
    const targetName = String(a.target ?? "").trim().replace(/^:+|:+$/g, "").toLowerCase();
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
    const name = String(a.name ?? "").trim().replace(/^:+|:+$/g, "").toLowerCase();
    const row = await this.liveEmoji(workspace, name);
    if (!row) return fail("not_found", `This workspace has no :${name}: emoji.`);
    if (!mayRemove(row.created_by, userKey(a.viewer!), roleOf(a.viewer, a.workspace))) {
      return fail("forbidden", "Only whoever added an emoji, or an owner, can remove it.");
    }
    // An emoji goes with its aliases; an alias goes alone.
    await this.db
      .prepare(
        "UPDATE custom_emoji SET deleted_at = ?1 WHERE workspace_id = ?2 AND deleted_at IS NULL AND (name = ?3 OR (?4 = 0 AND alias_of = ?3))",
      )
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
    case "post_as_agent":
      return Response.json(await service.postAsAgent(args));
    case "card_action":
      return Response.json(await service.cardAction(args));
    case "update_as_agent":
      return Response.json(await service.updateAsAgent(args));
    case "agent_typing":
      return Response.json(await service.agentTyping(args));
    case "history_for_agent":
      return Response.json(await service.historyForAgent(args));
    case "audience":
      return Response.json(await service.audience(args));
    case "search_for_agent":
      return Response.json(await service.searchForAgent(args));
    case "thread_for_agent":
      return Response.json(await service.threadForAgent(args));
    case "react":
      return Response.json(await service.react(args));
    case "unreact":
      return Response.json(await service.unreact(args));
    case "react_as_agent":
      return Response.json(await service.reactAsAgent(args));
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
    const match = url.pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (request.method !== "POST" || !match) return new Response("Not found\n", { status: 404 });
    // A replica near the caller when it asks for one (@g1t/contracts d1.ts).
    const opened = openD1(env.DB, request);
    const service = new Chat(Object.create(env, { DB: { value: opened.db } }) as Env, (work) => ctx.waitUntil(work));
    const args = (await request.json().catch(() => ({}))) as any;
    return opened.finish(await answer(service, match[1], args));
  },
} satisfies ExportedHandler<Env>;
