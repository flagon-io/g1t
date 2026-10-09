/**
 * One page's live room, as a Durable Object named by the page id.
 *
 * It owns the page's Yjs document: every editor's socket syncs with it
 * (the y-protocols sync and awareness messages, as binary frames), and
 * every change made on the server (an agent's edit, an accepted
 * suggestion, a restore, a comment) is applied here, so all of them merge
 * as one CRDT. It holds sockets with the WebSocket Hibernation API, so a
 * page people have open but aren't typing in costs nothing between
 * keystrokes; the document is read back from storage when it wakes.
 *
 * Storage (the object's own SQLite): the document as a snapshot plus the
 * updates since, compacted every so often. A few seconds after a burst of
 * edits (an alarm), the room saves the Markdown rendition, the search
 * index, backlinks and history to D1 (src/persist.ts).
 *
 * The room authorizes nothing about who may open the page: the Worker
 * checks the viewer's role before forwarding a socket (src/index.ts,
 * `live`) and puts it in ROOM_MEMBER_HEADER. The room enforces that role:
 * a socket that may only view or comment never changes the document.
 */
import { DurableObject } from "cloudflare:workers";

import type { DocEditTarget, DocRole, DocThreadAction, DocVersionKind, DocsLiveEvent, MemberProfile, ServiceBinding } from "@g1t/contracts";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { atLeast } from "./access.ts";
import { seed } from "./blocks.ts";
import { anchorThread, applyEdit, findTarget, rangeIds, rangeMarkdown, restoreFrom, unanchorThread } from "./edits.ts";
import { bodyCitations } from "./citations.ts";
import { citationNodes, documentMarkdown, mentionedIds, outline, type Outline } from "./markdown.ts";
import { save } from "./persist.ts";
import { applyThreadAction, listThreads, setQuote, type ThreadResult } from "./threads.ts";

/** Header the Worker sets on a socket it forwards: who it is, as JSON (`RoomMember`). */
export const ROOM_MEMBER_HEADER = "x-g1t-docs-member";

export type RoomMember = {
  page_id: string;
  workspace_slug: string;
  /** `user:<id>`. */
  key: string;
  member: MemberProfile;
  role: DocRole;
};

/** Who made a change on the server, for history. */
export type Origin = { key: string; kind: DocVersionKind; note: string | null; authors?: string[] };

type Attachment = RoomMember & { clients: number[] };

type Env = { DB: D1Database; NOTIFY?: ServiceBinding; EVENTS?: ServiceBinding };

const FRAGMENT = "document-store";
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
/** Save this long after the last change. */
const SAVE_AFTER_MS = 4_000;
/** Compact the stored updates into one snapshot past this many. */
const COMPACT_AT = 300;

export class PageRoom extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  /** The last awareness update each client sent, so newcomers see everyone at once. Lost on hibernation; clients resend every 15 s. */
  private awareness = new Map<number, Uint8Array>();
  /** Each client's last awareness clock, to mark it gone with the next one. */
  private clocks = new Map<number, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    });
  }

  // ── State ──────────────────────────────────────────────────────────────

  private meta<T>(key: string, fallback: T): T {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  private setMeta(key: string, value: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  /** The document, read from storage the first time it is needed after waking. */
  private load(): Y.Doc {
    if (this.doc) return this.doc;
    const doc = new Y.Doc({ gc: true });
    const snapshot = this.ctx.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM snapshot WHERE id = 1").toArray()[0];
    if (snapshot) Y.applyUpdate(doc, new Uint8Array(snapshot.data));
    for (const row of this.ctx.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM updates ORDER BY seq")) {
      Y.applyUpdate(doc, new Uint8Array(row.data));
    }
    doc.on("update", (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
    this.doc = doc;
    return doc;
  }

  private fragment(): Y.XmlFragment {
    return this.load().getXmlFragment(FRAGMENT);
  }

  private onUpdate(update: Uint8Array, origin: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO updates (data) VALUES (?)", update);
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM updates").one().n;
    if (count >= COMPACT_AT) this.compact();
    // Who changed it: a socket's member, or a change made here.
    const member = origin instanceof WebSocket ? (origin.deserializeAttachment() as Attachment | null) : null;
    const key = member ? member.key : (origin as Origin | null)?.key;
    if (member?.member.kind === "user") {
      const names = this.meta<string[]>("editor_names", []);
      const name = member.member.name.toLowerCase();
      if (!names.includes(name)) this.setMeta("editor_names", [...names, name]);
    }
    if (key) {
      const editors = this.meta<string[]>("editors", []).filter((k) => k !== key);
      editors.push(key);
      this.setMeta("editors", editors);
      const pending = this.meta<string[]>("pending_authors", []);
      if (!pending.includes(key)) this.setMeta("pending_authors", [...pending, key]);
    }
    // Everyone else sees it at once.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder), origin instanceof WebSocket ? origin : null);
    this.scheduleSave();
  }

  private compact(): void {
    const doc = this.load();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO snapshot (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data", Y.encodeStateAsUpdate(doc));
      this.ctx.storage.sql.exec("DELETE FROM updates");
    });
  }

  private scheduleSave(): void {
    void this.ctx.storage.getAlarm().then((at) => {
      if (at == null) return this.ctx.storage.setAlarm(Date.now() + SAVE_AFTER_MS);
    });
  }

  private send(message: Uint8Array | string, except: WebSocket | null = null): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(message);
      } catch {
        // Closing already.
      }
    }
  }

  /** Saves to D1 now: the Markdown, search, links, mentions, and a version if one is due or asked for. */
  private async persist(version: Origin | null = null): Promise<string | null> {
    const pageId = this.meta<string | null>("page_id", null);
    if (!pageId) return null;
    const fragment = this.fragment();
    const editors = this.meta<string[]>("editors", []);
    const pending = this.meta<string[]>("pending_authors", []);
    const markdown = documentMarkdown(fragment);
    const result = await save(this.env, {
      page_id: pageId,
      markdown,
      citations: bodyCitations(citationNodes(fragment), markdown),
      editors,
      mentioned: mentionedIds(fragment).users,
      editor_names: this.meta<string[]>("editor_names", []),
      state: Y.encodeStateAsUpdate(this.load()),
      version: version ? { kind: version.kind, note: version.note, authors: version.authors ?? [version.key] } : null,
      pending_authors: pending,
      last_version_at: this.meta<number>("last_version_at", 0),
      workspace_slug: this.meta<string | null>("workspace_slug", null),
    });
    this.setMeta("editors", []);
    this.setMeta("editor_names", []);
    if (result.version_id) {
      this.setMeta("last_version_at", Date.now());
      this.setMeta("pending_authors", []);
    }
    return result.version_id;
  }

  override async alarm(): Promise<void> {
    await this.persist();
  }

  // ── Calls from the Worker ──────────────────────────────────────────────

  /**
   * Names the page this room is for, and fills an empty document from
   * Markdown (a template, an agent's new page, or a page made before its
   * room existed) or from a Yjs state (a duplicate).
   */
  async ensure(init: { page_id: string; workspace_slug: string; markdown?: string | null; state?: Uint8Array | null }): Promise<void> {
    this.setMeta("page_id", init.page_id);
    if (init.workspace_slug) this.setMeta("workspace_slug", init.workspace_slug);
    const doc = this.load();
    const fragment = this.fragment();
    if (fragment.length > 0) return;
    if (init.state) Y.applyUpdate(doc, init.state, { key: "system", kind: "created", note: null } satisfies Origin);
    else seed(doc, fragment, init.markdown ?? "");
  }

  /** The document as Markdown, and its top-level blocks. */
  async read(): Promise<{ markdown: string; blocks: Outline[] }> {
    const fragment = this.fragment();
    return { markdown: documentMarkdown(fragment), blocks: outline(fragment) };
  }

  /** The whole document's state, for a duplicate. */
  async state(): Promise<Uint8Array> {
    return Y.encodeStateAsUpdate(this.load());
  }

  /** A target's current Markdown and blocks, or null when it is gone. */
  async target(target: DocEditTarget): Promise<{ markdown: string; block_ids: string[] } | null> {
    const fragment = this.fragment();
    const range = findTarget(fragment, target);
    if (!range) return null;
    return { markdown: rangeMarkdown(fragment, range), block_ids: rangeIds(fragment, range) };
  }

  /** Where each target is now, for marking open suggestions in the editor. */
  async targets(targets: DocEditTarget[]): Promise<(string[] | null)[]> {
    const fragment = this.fragment();
    return targets.map((t) => {
      const range = findTarget(fragment, t);
      return range ? rangeIds(fragment, range) : null;
    });
  }

  /** Applies an edit and records a version for it. False when the target is gone. */
  async edit(target: DocEditTarget, markdown: string, origin: Origin): Promise<{ applied: boolean; version_id: string | null }> {
    const doc = this.load();
    const applied = applyEdit(doc, this.fragment(), target, markdown, origin);
    if (!applied) return { applied: false, version_id: null };
    const version_id = await this.persist(origin);
    return { applied, version_id };
  }

  /** Makes the document what a version's was, as a new version. */
  async restore(input: { state: Uint8Array | null; markdown: string }, origin: Origin): Promise<string | null> {
    const doc = this.load();
    if (input.state) {
      const old = new Y.Doc();
      Y.applyUpdate(old, input.state);
      restoreFrom(doc, this.fragment(), old.getXmlFragment(FRAGMENT), origin);
    } else applyEdit(doc, this.fragment(), { kind: "document" }, input.markdown, origin);
    return this.persist(origin);
  }

  /** A comment operation from `actor` with `role`. */
  async thread(actor: string, role: DocRole, action: DocThreadAction): Promise<ThreadResult> {
    const doc = this.load();
    if (action.op === "anchor") {
      if (!atLeast(role, "comment")) return { ok: false, code: "forbidden", message: "You can read this page but not comment on it." };
      const thread = doc.getMap<Y.Map<unknown>>("threads").get(action.thread_id);
      if (!thread) return { ok: false, code: "not_found", message: "That thread is gone." };
      const quote = anchorThread(doc, this.fragment(), action.anchor, action.head, action.thread_id);
      if (quote) setQuote(doc, action.thread_id, quote);
      return { ok: true, value: { quote } };
    }
    const result = applyThreadAction(doc, actor, role, action);
    if (result.ok && action.op === "delete_thread") unanchorThread(doc, this.fragment(), action.thread_id);
    return result;
  }

  /** The page's threads, authors as member keys. */
  async threads(): Promise<ReturnType<typeof listThreads>> {
    return listThreads(this.load());
  }

  /**
   * Shows an agent on the page for a little while (its face in everyone's
   * presence row) when it edits or suggests: an awareness entry of its
   * own, which editors drop after 30 s without renewal, as for anyone.
   */
  async announce(key: string, name: string): Promise<void> {
    let id = 0;
    for (let i = 0; i < key.length; i++) id = (Math.imul(id, 31) + key.charCodeAt(i)) | 0;
    const client = (id & 0x3fffffff) + 1;
    const clock = Math.floor(Date.now() / 1000);
    const state = JSON.stringify({ user: { name, color: "#b8a6ff", key, kind: "agent", avatar: "" } });
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, client);
    encoding.writeVarUint(update, clock);
    encoding.writeVarString(update, state);
    const bytes = encoding.toUint8Array(update);
    this.awareness.set(client, bytes);
    this.clocks.set(client, clock);
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(message, bytes);
    this.send(encoding.toUint8Array(message));
  }

  /** Tells everyone with the page open. */
  async notice(event: DocsLiveEvent): Promise<void> {
    this.send(JSON.stringify(event));
  }

  /** A member's role changed (null: they can no longer read it): their sockets follow. */
  async setRole(key: string, role: DocRole | null): Promise<void> {
    for (const socket of this.ctx.getWebSockets(key)) {
      const who = socket.deserializeAttachment() as Attachment | null;
      if (!who) continue;
      if (!role) {
        try {
          socket.close(4403, "No longer allowed");
        } catch {
          // Already closed.
        }
        continue;
      }
      socket.serializeAttachment({ ...who, role });
      try {
        socket.send(JSON.stringify({ type: "access", role } satisfies DocsLiveEvent));
      } catch {
        // Closing.
      }
    }
  }

  /** Saves now, as before the page is archived or exported. */
  async flush(): Promise<void> {
    if (this.doc) await this.persist();
  }

  /** Closes every socket: the page went to the trash. */
  async closeAll(reason: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "page.archived", page_id: this.meta<string>("page_id", "") } satisfies DocsLiveEvent));
        socket.close(4410, reason);
      } catch {
        // Already closed.
      }
    }
  }

  // ── Sockets ────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade\n", { status: 426 });
    }
    let who: RoomMember;
    try {
      who = JSON.parse(request.headers.get(ROOM_MEMBER_HEADER) ?? "") as RoomMember;
    } catch {
      return new Response("Missing member\n", { status: 400 });
    }
    if (who.workspace_slug) this.setMeta("workspace_slug", who.workspace_slug);
    if (who.page_id) this.setMeta("page_id", who.page_id);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [who.key]);
    server.serializeAttachment({ ...who, clients: [] } satisfies Attachment);
    // Start syncing: our state vector, and everyone's presence so far.
    const doc = this.load();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    server.send(encoding.toUint8Array(encoder));
    for (const update of this.awareness.values()) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(e, update);
      server.send(encoding.toUint8Array(e));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Text frames are for the Worker's notices only; clients speak binary.
    if (typeof message === "string") return;
    const who = socket.deserializeAttachment() as Attachment | null;
    if (!who) return;
    const data = new Uint8Array(message);
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      // Peek at the sync message: viewers and commenters may ask for the
      // document (step 1) but never change it (step 2, update).
      const peek = decoding.createDecoder(data);
      decoding.readVarUint(peek);
      const step = decoding.readVarUint(peek);
      if (step !== syncProtocol.messageYjsSyncStep1 && !atLeast(who.role, "edit")) return;
      const doc = this.load();
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
      if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
      return;
    }
    if (type === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      // Remember which clients this socket speaks for, to clear them when it closes.
      const entries = awarenessEntries(update);
      const clients = entries.map((e) => e.id);
      for (const e of entries) {
        this.clocks.set(e.id, e.clock);
        if (e.gone) this.awareness.delete(e.id);
        else this.awareness.set(e.id, update);
      }
      const known = new Set(who.clients);
      if (clients.some((id) => !known.has(id))) socket.serializeAttachment({ ...who, clients: [...new Set([...who.clients, ...clients])] });
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, update);
      this.send(encoding.toUint8Array(encoder), socket);
      return;
    }
    if (type === MESSAGE_QUERY_AWARENESS) {
      for (const update of this.awareness.values()) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, update);
        socket.send(encoding.toUint8Array(encoder));
      }
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    this.leave(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    this.leave(socket);
  }

  /** Tells everyone a closed socket's people left: their cursors go. */
  private leave(socket: WebSocket): void {
    const who = socket.deserializeAttachment() as Attachment | null;
    if (!who?.clients.length) return;
    for (const id of who.clients) this.awareness.delete(id);
    // Marks each client gone (state null, the next clock). One whose clock
    // was lost to hibernation is left to time out in the others' editors
    // (30 s), as y-protocols does for any client that stops renewing.
    const gone = who.clients.filter((id) => this.clocks.has(id));
    if (!gone.length) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, gone.length);
    for (const id of gone) {
      encoding.writeVarUint(encoder, id);
      encoding.writeVarUint(encoder, this.clocks.get(id)! + 1);
      encoding.writeVarString(encoder, "null");
      this.clocks.delete(id);
    }
    const update = encoding.toUint8Array(encoder);
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(message, update);
    this.send(encoding.toUint8Array(message), socket);
  }
}

/** The clients in an awareness update (its format: count, then id, clock, JSON state). */
export function awarenessEntries(update: Uint8Array): { id: number; clock: number; gone: boolean }[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const out: { id: number; clock: number; gone: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = decoding.readVarString(decoder);
    out.push({ id, clock, gone: state === "null" });
  }
  return out;
}

