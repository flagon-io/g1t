/**
 * An artifact's live connection, whatever its kind: the Yjs document and
 * everyone's presence, synced over
 * `wss://<site>/<workspace>/-/artifacts/live?folio=<id>` with the folio's
 * room (services/artifacts src/folios/room.ts). Binary frames speak the
 * y-protocols sync and awareness messages; text frames are the service's
 * own notices (`FoliosLiveEvent`): a rename, a new suggestion, a version,
 * a change of access.
 *
 * It reconnects with backoff when the socket drops, and says where it is
 * (`status`) so the page can show "Offline, changes will sync".
 * Browser-only.
 */
import type { FoliosLiveEvent } from "@g1t/contracts";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { openLive } from "../../lib/live-socket";
import { heldOpen } from "../../lib/notify-store";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

export type LiveStatus = "connecting" | "synced" | "offline" | "closed";

export class FolioProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  status: LiveStatus = "connecting";
  private socket: WebSocket | null = null;
  private attempts = 0;
  /** When the current connection opened; the backoff starts over only once one holds. */
  private openedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Between asking for a socket ticket and opening the socket. */
  private opening = false;
  private readonly statusListeners = new Set<(status: LiveStatus) => void>();
  private readonly eventListeners = new Set<(event: FoliosLiveEvent) => void>();

  constructor(
    private readonly url: string,
    doc?: Y.Doc,
  ) {
    this.doc = doc ?? new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.onUnload);
      window.addEventListener("online", this.onOnline);
    }
    this.connect();
  }

  onStatus(listener: (status: LiveStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onEvent(listener: (event: FoliosLiveEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private setStatus(status: LiveStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }

  private connect() {
    if (this.stopped || this.opening) return;
    this.setStatus(this.attempts ? "offline" : "connecting");
    // A page opened with an access token adds a socket ticket first (lib/live-socket.ts).
    const target = new URL(this.url);
    this.opening = true;
    openLive(
      target.pathname,
      () => Object.fromEntries(target.searchParams),
      (address) => {
        this.opening = false;
        this.open(address);
      },
      () => {
        if (!this.stopped) return false;
        this.opening = false;
        return true;
      },
    );
  }

  private open(address: string) {
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.openedAt = Date.now();
      // Our state vector: the room answers with what we lack, and asks for what it lacks.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      socket.send(encoding.toUint8Array(encoder));
      if (this.awareness.getLocalState() !== null) {
        const a = encoding.createEncoder();
        encoding.writeVarUint(a, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
        socket.send(encoding.toUint8Array(a));
      }
      const q = encoding.createEncoder();
      encoding.writeVarUint(q, MESSAGE_QUERY_AWARENESS);
      socket.send(encoding.toUint8Array(q));
      if (this.keepalive) clearInterval(this.keepalive);
      // Answered at the edge without waking the room.
      this.keepalive = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send("ping"), 25_000);
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        if (event.data === "pong") return;
        try {
          const parsed = JSON.parse(event.data) as FoliosLiveEvent;
          for (const l of this.eventListeners) l(parsed);
        } catch {
          // Not ours.
        }
        return;
      }
      this.receive(new Uint8Array(event.data as ArrayBuffer));
    };
    socket.onclose = (event) => {
      if (this.keepalive) clearInterval(this.keepalive);
      this.socket = null;
      // Others stop seeing our cursor; we stop seeing theirs.
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID),
        this,
      );
      // 4403: no longer allowed; 4410: in the trash. Neither comes back by retrying.
      if (event.code === 4403 || event.code === 4410 || this.stopped) {
        this.setStatus("closed");
        return;
      }
      this.setStatus("offline");
      // Only a connection that held starts the backoff over.
      if (heldOpen(this.openedAt)) this.attempts = 0;
      this.openedAt = null;
      const delay = Math.min(30_000, 500 * 2 ** this.attempts) + Math.random() * 500;
      this.attempts++;
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private receive(data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const step = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) this.socket?.send(encoding.toUint8Array(encoder));
      if (step === syncProtocol.messageYjsSyncStep2) this.setStatus("synced");
      return;
    }
    if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encoding.toUint8Array(encoder));
    // While offline, the update stays in the document and goes in the next sync.
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this) return;
    const changed = [...added, ...updated, ...removed];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encoding.toUint8Array(encoder));
  };

  private onUnload = () => {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "unload");
  };

  private onOnline = () => {
    if (this.socket || this.opening || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.attempts = 0;
    this.connect();
  };

  destroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.keepalive) clearInterval(this.keepalive);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.onUnload);
      window.removeEventListener("online", this.onOnline);
    }
    this.socket?.close();
    this.awareness.destroy();
  }
}
