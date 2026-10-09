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
  type AgentPostMessage,
  type AskerAccess,
  type Channel,
  type ChannelMember,
  type ChatLiveEvent,
  type ChatMessage,
  type ChatSidebar,
  type ChatSidebarEntry,

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
  type WorkspaceAgent,
} from "@g1t/contracts";

import { MAX_HOPS, deliveries, delivery, type Chain } from "./delivery.ts";
import { mentionedHandles, mentionsColumn } from "./mentions.ts";
import { AGENT_TYPING_MS, historyOf, historySize, messageBody, meterDay, pageOf, pageSize } from "./messages.ts";
import { GENERAL, MAX_DM_MEMBERS, channelName, dmKey, dmMembers } from "./names.ts";
import { ROOM_MEMBER_HEADER, type ChannelRoom, type RoomMember } from "./room.ts";
import { dmTitle, sidebarOrder, tally, type UnreadRow } from "./unread.ts";

export { ChannelRoom } from "./room.ts";

// The hop limit here is the one in the contract.
const SAME_HOP_LIMIT: typeof CHAT_MAX_HOPS = MAX_HOPS;
void SAME_HOP_LIMIT;

type Env = {
  DB: D1Database;
  IDENTITY: ServiceBinding;
  AGENTS: ServiceBinding;
  ROOMS: DurableObjectNamespace<ChannelRoom>;
};

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

/** A card as kept, or null when what was sent is not one. */
function cleanCard(card: unknown): MessageCard | null {
  if (!card || typeof card !== "object") return null;
  const c = card as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const kind = text(c.kind, 40);
  const title = text(c.title, 300);
  if (!kind || !title) return null;
  const href = text(c.href, 2000);
  return {
    kind,
    title,
    detail: text(c.detail, 500),
    state: text(c.state, 80),
    // Relative to the site only: a card never links somewhere else.
    href: href && href.startsWith("/") && !href.startsWith("//") ? href : null,
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
          display_name: person?.name || username || "Former member",
          avatar: person?.avatar ?? null,
          role: null,
        });
      } else {
        const agent = agents.get(p.id) ?? null;
        out.set(principalKey(p), {
          ...p,
          name: agent?.handle ?? p.id,
          display_name: agent?.display_name ?? "Former agent",
          avatar: agent?.avatar ?? null,
          role: agent?.role ?? null,
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

  private async toMessages(slug: string, workspace: Workspace, rows: MessageRow[]): Promise<ChatMessage[]> {
    const profiles = await this.profiles(slug, workspace, rows.map((r) => r.author));
    return rows.map((row) => {
      const gone = !!row.deleted_at;
      return {
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
    if (general && !general.private && !general.archived_at) {
      statements.push(this.joinStatement(general.id, me, general.created_by === me ? "owner" : "member", at));
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
    return ok({ entries: sidebarOrder(entries), browsable: browsable?.n ?? 0 });
  }

  // ── Channels ────────────────────────────────────────────────────────────

  async channel(a: { workspace: string; channel_id: string; viewer: Viewer }): Promise<Result<{ channel: Channel; members: ChannelMember[] }>> {
    const found = await this.place(a.workspace, a.channel_id, a.viewer, "read");
    if (!found.ok) return found;
    const { slug, workspace, channel } = found.value;
    const rows = await this.db
      .prepare("SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at, principal")
      .bind(channel.id)
      .all<MemberRow>();
    const profiles = await this.profiles(slug, workspace, rows.results.map((r) => r.principal));
    return ok({
      channel: toChannel(channel),
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
  async channelByName(a: { workspace: string; name: string; viewer: Viewer }): Promise<Result<{ channel: Channel; members: ChannelMember[] }>> {
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

  async browse(a: { workspace: string; viewer: Viewer }): Promise<Result<Channel[]>> {
    const found = await this.viewerWorkspace(a.workspace, a.viewer);
    if (!found.ok) return found;
    const rows = await this.db
      .prepare(
        "SELECT * FROM channels WHERE workspace_id = ? AND kind = 'channel' AND private = 0 AND archived_at IS NULL ORDER BY name",
      )
      .bind(found.value.id)
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
      private: a.input?.private ? 1 : 0,
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
    return ok(null);
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
      return ok({ messages: await this.toMessages(slug, workspace, page.rows), older: null, newer: page.older });
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
    if (root && page.older === null) {
      const first = await this.messageRow(channel.id, root);
      if (first) list = [...list, first];
    }
    return ok({ messages: await this.toMessages(slug, workspace, list), older: page.older });
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
    if (!ids.length) return;
    const found = await this.agentsById(ids);
    const agents = [...found.values()].filter(
      (agent): agent is WorkspaceAgent => !!agent && agent.workspace_id === workspace.id && !agent.archived_at,
    );
    const wakes = deliveries({
      author: row.author,
      hops: chain.hops,
      channelKind: channel.kind,
      agents: agents.map((agent) => ({ id: agent.id, handle: agent.handle })),
      mentioned: handles,
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
      { hops: 0, asked_by: a.viewer!.id, asker: askerAccess(a.viewer!, a.workspace) },
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
      { hops, asked_by: askedBy, asker: cleanAsker(a.message?.asker) },
    );
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
    case "agent_typing":
      return Response.json(await service.agentTyping(args));
    case "history_for_agent":
      return Response.json(await service.historyForAgent(args));
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
