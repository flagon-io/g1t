/**
 * One folio's live room, as a Durable Object named by the folio id: the
 * same socket protocol, hibernation, roles, save alarm and index alarm as
 * a Docs page's room (src/room.ts, PageRoom), for every kind of folio
 * through its kind's model (src/kinds/). The kind is kept in `meta`.
 *
 * It owns the folio's Yjs document: every editor's socket syncs with it
 * (y-protocols sync and awareness, binary frames), and every change made
 * on the server (an agent's edit, an accepted suggestion, a restore, a
 * comment) is applied here, so all of them merge as one CRDT. A few
 * seconds after a burst of edits (an alarm) it saves the kind's text
 * rendition, card, links, citations and history to D1 (src/persist.ts
 * `saveFolio`); half a minute after the text first changes, it brings
 * the folio's passages in the index up to date (src/indexer.ts
 * `indexFolio`).
 *
 * The room authorizes nothing about who may open the folio: the Worker
 * checks the viewer's role before forwarding a socket
 * (src/folios/service.ts, `live`) and puts it in ROOM_MEMBER_HEADER. The
 * room enforces that role: a socket that may only view or comment never
 * changes the document. Access changes reach open sockets through
 * `setRole`; a socket whose access ended closes with 4403.
 */
import { DurableObject } from "cloudflare:workers";

import type { DocEditTarget, DocRole, DocThreadAction, FolioAgentEdit, FolioKind, FoliosLiveEvent, MemberProfile, ServiceBinding } from "@g1t/contracts";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { atLeast } from "../access.ts";
import { anchorThread, unanchorThread } from "../edits.ts";
import type { FileStoreEnv } from "../files.ts";
import { indexFolio, type IndexEnv } from "../indexer.ts";
import { docFragment, docTarget, docTargets } from "../kinds/doc/index.ts";
import { kindModel } from "../kinds/index.ts";
import type { AgentForm, FolioOrigin, KindModel } from "../kinds/types.ts";
import { saveFolio } from "../persist.ts";
import { ROOM_MEMBER_HEADER, awarenessEntries } from "../room.ts";
import { applyThreadAction, listThreads, setQuote, type ThreadResult } from "../threads.ts";
import { notifyFolioMentions } from "./service.ts";

export { ROOM_MEMBER_HEADER };

export type FolioRoomMember = {
  folio_id: string;
  workspace_slug: string;
  /** `user:<id>`. */
  key: string;
  member: MemberProfile;
  role: DocRole;
};

type Attachment = FolioRoomMember & { clients: number[] };

export type FolioRoomEnv = IndexEnv &
  FileStoreEnv & {
    DB: D1Database;
    NOTIFY?: ServiceBinding;
    EVENTS?: ServiceBinding;
    IDENTITY: ServiceBinding;
    AGENTS: ServiceBinding;
    REPOS?: ServiceBinding;
    /** The rooms themselves, as the Worker binds them (mentions are checked through the service). */
    FOLIOS: DurableObjectNamespace<FolioRoom>;
  };

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
/** Save this long after the last change. */
const SAVE_AFTER_MS = 4_000;
/** Index this long after the text first changed: at most twice a minute while someone types. */
const INDEX_AFTER_MS = 30_000;
/** Compact the stored updates into one snapshot past this many. */
const COMPACT_AT = 300;

export class FolioRoom extends DurableObject<FolioRoomEnv> {
  private doc: Y.Doc | null = null;
  /** The last awareness update each client sent. Lost on hibernation; clients resend every 15 s. */
  private awareness = new Map<number, Uint8Array>();
  private clocks = new Map<number, number>();

  constructor(ctx: DurableObjectState, env: FolioRoomEnv) {
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

  /** The kind's model. Every room is named and given its kind by `ensure` (or a socket) before anything else. */
  private model(): KindModel {
    const model = kindModel(this.meta<string | null>("kind", null));
    if (!model) throw new Error(`folio room ${this.meta<string>("folio_id", "?")} has no kind it knows`);
    return model;
  }

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

  private onUpdate(update: Uint8Array, origin: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO updates (data) VALUES (?)", update);
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM updates").one().n;
    if (count >= COMPACT_AT) this.compact();
    const member = origin instanceof WebSocket ? (origin.deserializeAttachment() as Attachment | null) : null;
    const key = member ? member.key : (origin as FolioOrigin | null)?.key;
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
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder), origin instanceof WebSocket ? origin : null);
    this.alarmBy(Date.now() + SAVE_AFTER_MS);
  }

  private compact(): void {
    const doc = this.load();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO snapshot (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data", Y.encodeStateAsUpdate(doc));
      this.ctx.storage.sql.exec("DELETE FROM updates");
    });
  }

  private alarmBy(when: number): void {
    void this.ctx.storage.getAlarm().then((at) => {
      if (at == null || at > when) return this.ctx.storage.setAlarm(when);
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

  /** Saves to D1 now: the rendition, search, links, citations, and a version if one is due or asked for. */
  private async persist(version: FolioOrigin | null = null): Promise<string | null> {
    const folioId = this.meta<string | null>("folio_id", null);
    if (!folioId || !kindModel(this.meta<string | null>("kind", null))) return null;
    const doc = this.load();
    const pending = this.meta<string[]>("pending_authors", []);
    const result = await saveFolio(this.env, {
      folio_id: folioId,
      rendition: this.model().render(doc),
      editors: this.meta<string[]>("editors", []),
      editor_names: this.meta<string[]>("editor_names", []),
      state: Y.encodeStateAsUpdate(doc),
      version: version ? { kind: version.kind, note: version.note, authors: version.authors ?? [version.key] } : null,
      pending_authors: pending,
      last_version_at: this.meta<number>("last_version_at", 0),
      workspace_slug: this.meta<string | null>("workspace_slug", null),
    });
    this.setMeta("editors", []);
    this.setMeta("editor_names", []);
    if (result.changed && this.meta<number | null>("index_at", null) == null) {
      const when = Date.now() + INDEX_AFTER_MS;
      this.setMeta("index_at", when);
      this.alarmBy(when);
    }
    if (result.version_id) {
      this.setMeta("last_version_at", Date.now());
      this.setMeta("pending_authors", []);
    }
    if (result.mentioned.length) {
      // Told only if they can read it (the service checks), so this waits on nothing.
      const slug = this.meta<string | null>("workspace_slug", null);
      if (slug) {
        this.ctx.waitUntil(notifyFolioMentions(this.env, slug, folioId, result.mentioned, result.last).catch((error: unknown) => console.error("folios could not tell people they were mentioned", String(error))));
      }
    }
    return result.version_id;
  }

  override async alarm(): Promise<void> {
    await this.persist();
    const due = this.meta<number | null>("index_at", null);
    if (due == null) return;
    if (Date.now() < due) return this.alarmBy(due);
    this.setMeta("index_at", null);
    const folioId = this.meta<string | null>("folio_id", null);
    if (folioId) await indexFolio(this.env, folioId);
  }

  // ── Calls from the Worker ──────────────────────────────────────────────

  /**
   * Names the folio and its kind, and fills an empty document: from a
   * Yjs state (a duplicate), or the kind's seed from text or a spec (a
   * template, an agent's new folio, or blank).
   */
  async ensure(init: { folio_id: string; kind: FolioKind; workspace_slug: string; text?: string | null; spec?: unknown; state?: Uint8Array | null }): Promise<void> {
    this.setMeta("folio_id", init.folio_id);
    this.setMeta("kind", init.kind);
    if (init.workspace_slug) this.setMeta("workspace_slug", init.workspace_slug);
    const doc = this.load();
    const model = this.model();
    if (!model.isEmpty(doc)) return;
    // No origin: filling a new room is its "created" version (written by the service), nobody's edit.
    if (init.state) Y.applyUpdate(doc, init.state);
    else doc.transact(() => model.seed(doc, { text: init.text ?? null, spec: init.spec }));
  }

  /** The folio in its agent form. */
  async read(): Promise<AgentForm> {
    return this.model().read(this.load());
  }

  /** The text rendition now (unsaved edits included). */
  async text(): Promise<string> {
    return this.model().render(this.load()).text;
  }

  /** The whole document's state, for a duplicate. */
  async state(): Promise<Uint8Array> {
    return Y.encodeStateAsUpdate(this.load());
  }

  /** A doc's target now, or null when it is gone (doc kind only). */
  async target(target: DocEditTarget): Promise<{ markdown: string; block_ids: string[] } | null> {
    if (this.model().kind !== "doc") return null;
    return docTarget(this.load(), target);
  }

  async targets(targets: DocEditTarget[]): Promise<(string[] | null)[]> {
    if (this.model().kind !== "doc") return targets.map(() => null);
    return docTargets(this.load(), targets);
  }

  /** Applies an edit in the kind's terms and records a version for it. */
  async edit(edit: FolioAgentEdit, origin: FolioOrigin): Promise<{ applied: boolean; version_id: string | null; summary: string }> {
    const doc = this.load();
    const model = this.model();
    const result = model.applyAgentEdit(doc, edit, origin);
    if (!result.applied) return { applied: false, version_id: null, summary: result.summary };
    const version_id = await this.persist({ ...origin, note: origin.note ?? result.summary });
    return { applied: true, version_id, summary: result.summary };
  }

  /** Makes the document what a version's was, as a new version. */
  async restore(input: { state: Uint8Array | null; text: string }, origin: FolioOrigin): Promise<string | null> {
    const doc = this.load();
    const model = this.model();
    if (input.state) {
      const old = new Y.Doc();
      Y.applyUpdate(old, input.state);
      model.restore(doc, old, origin);
    } else model.restoreText(doc, input.text, origin);
    return this.persist(origin);
  }

  /** A comment operation from `actor` with `role`. Anchoring in the text is the doc kind's. */
  async thread(actor: string, role: DocRole, action: DocThreadAction): Promise<ThreadResult> {
    const doc = this.load();
    const isDoc = this.model().kind === "doc";
    if (action.op === "anchor") {
      if (!atLeast(role, "comment")) return { ok: false, code: "forbidden", message: "You can read this but not comment on it." };
      if (!isDoc) return { ok: false, code: "invalid", message: "Comments on this kind of artifact are pinned, not anchored in text." };
      const thread = doc.getMap<Y.Map<unknown>>("threads").get(action.thread_id);
      if (!thread) return { ok: false, code: "not_found", message: "That thread is gone." };
      const quote = anchorThread(doc, docFragment(doc), action.anchor, action.head, action.thread_id);
      if (quote) setQuote(doc, action.thread_id, quote);
      return { ok: true, value: { quote } };
    }
    const result = applyThreadAction(doc, actor, role, action);
    if (result.ok && action.op === "delete_thread" && isDoc) unanchorThread(doc, docFragment(doc), action.thread_id);
    return result;
  }

  async threads(): Promise<ReturnType<typeof listThreads>> {
    return listThreads(this.load());
  }

  /** Shows an agent in everyone's presence row for a little while when it edits or suggests. */
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

  /** Tells everyone with the folio open. */
  async notice(event: FoliosLiveEvent): Promise<void> {
    this.send(JSON.stringify(event));
  }

  /** Who has it open: each socket's member key and username, for re-checking access. */
  async members(): Promise<{ key: string; name: string }[]> {
    const out = new Map<string, string>();
    for (const socket of this.ctx.getWebSockets()) {
      const who = socket.deserializeAttachment() as Attachment | null;
      if (who) out.set(who.key, who.member.name);
    }
    return [...out].map(([key, name]) => ({ key, name }));
  }

  /** A member's role changed (null: they can no longer read it): their sockets follow, or close with 4403. */
  async setRole(key: string, role: DocRole | null): Promise<void> {
    for (const socket of this.ctx.getWebSockets(key)) {
      const who = socket.deserializeAttachment() as Attachment | null;
      if (!who) continue;
      if (!role) {
        try {
          socket.send(JSON.stringify({ type: "access", role: null } satisfies FoliosLiveEvent));
          socket.close(4403, "No longer allowed");
        } catch {
          // Already closed.
        }
        continue;
      }
      if (who.role === role) continue;
      socket.serializeAttachment({ ...who, role });
      try {
        socket.send(JSON.stringify({ type: "access", role } satisfies FoliosLiveEvent));
      } catch {
        // Closing.
      }
    }
  }

  /** Saves now, as before a version list, an export or the trash. */
  async flush(): Promise<void> {
    if (this.doc) await this.persist();
  }

  /** Closes every socket: the folio went to the trash. */
  async closeAll(reason: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "folio.trashed", folio_id: this.meta<string>("folio_id", "") } satisfies FoliosLiveEvent));
        socket.close(4410, reason);
      } catch {
        // Already closed.
      }
    }
  }

  /** Forgets everything: the folio was deleted for good. */
  async destroy(): Promise<void> {
    await this.closeAll("Deleted");
    this.doc = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ── Sockets ────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade\n", { status: 426 });
    let who: FolioRoomMember;
    try {
      who = JSON.parse(request.headers.get(ROOM_MEMBER_HEADER) ?? "") as FolioRoomMember;
    } catch {
      return new Response("Missing member\n", { status: 400 });
    }
    if (!kindModel(this.meta<string | null>("kind", null))) return new Response("Not ready\n", { status: 409 });
    if (who.workspace_slug) this.setMeta("workspace_slug", who.workspace_slug);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [who.key]);
    server.serializeAttachment({ ...who, clients: [] } satisfies Attachment);
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
    if (typeof message === "string") return;
    const who = socket.deserializeAttachment() as Attachment | null;
    if (!who) return;
    const data = new Uint8Array(message);
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      // Viewers and commenters may ask for the document (step 1) but never change it.
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

  private leave(socket: WebSocket): void {
    const who = socket.deserializeAttachment() as Attachment | null;
    if (!who?.clients.length) return;
    for (const id of who.clients) this.awareness.delete(id);
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
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(message, encoding.toUint8Array(encoder));
    this.send(encoding.toUint8Array(message), socket);
  }
}
