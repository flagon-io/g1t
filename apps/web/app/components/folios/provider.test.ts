import assert from "node:assert/strict";
import { test } from "node:test";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { FolioProvider, pageStateBytes } from "./provider.ts";

// The provider is browser code; the little it needs of the browser, a page address and sockets, is faked here.
(globalThis as { location?: unknown }).location = { href: "https://g1t.test/acme/-/artifacts/x", protocol: "https:" };

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  sent: (Uint8Array | string)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: Uint8Array | string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
  /** The server's turn: a frame for the client. */
  receive(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;

const MESSAGE_SYNC = 0;

/** A room as src/folios/room.ts behaves: its own step 1 on connect, and an answer to every sync message. */
function room(doc: Y.Doc, socket: FakeSocket) {
  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(step1, doc);
  socket.receive(encoding.toUint8Array(step1));
  return {
    /** Reads what the client sent since, answering as the room would. */
    exchange() {
      for (const frame of socket.sent.splice(0)) {
        if (typeof frame === "string") continue;
        const decoder = decoding.createDecoder(frame);
        if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, "room");
        if (encoding.length(encoder) > 1) socket.receive(encoding.toUint8Array(encoder));
      }
    },
  };
}

function frames(socket: FakeSocket): number[] {
  return socket.sent.filter((f): f is Uint8Array => typeof f !== "string").map((f) => decoding.readVarUint(decoding.createDecoder(f)));
}

test("a doc seeded from the page's state opens at once, and what is typed before the room answers reaches it, once", (t) => {
  FakeSocket.instances = [];
  // The room's document, as the page carried its saved state.
  const server = new Y.Doc();
  server.getText("t").insert(0, "hello");
  const carried = Y.encodeStateAsUpdate(server);
  // Someone else edited after the save: the room is ahead of the page.
  server.getText("t").insert(0, "Oh, ");

  const provider = new FolioProvider("wss://g1t.test/acme/-/artifacts/live?folio=f1", { state: carried });
  t.after(() => provider.destroy());
  assert.equal(provider.seeded, true);
  assert.equal(provider.doc.getText("t").toString(), "hello", "the editor can open on the page's document before any socket");
  assert.equal(provider.status, "connecting");
  const socket = FakeSocket.instances[0]!;
  assert.equal(socket.url, "wss://g1t.test/acme/-/artifacts/live?folio=f1");

  // Typed before the socket opened: kept in the document, nothing sent yet.
  provider.doc.getText("t").insert(5, " world");
  assert.deepEqual(frames(socket), [], "nothing goes down a socket that is not open");

  socket.readyState = FakeSocket.OPEN;
  socket.onopen?.();
  assert.deepEqual(frames(socket), [MESSAGE_SYNC, 1, 3], "on open: our state vector, our presence, and a question about who is here");
  const theRoom = room(server, socket);
  theRoom.exchange();
  theRoom.exchange();
  assert.equal(provider.status, "synced");
  assert.equal(server.getText("t").toString(), "Oh, hello world", "the room got the early edit, and only once");
  assert.equal(provider.doc.getText("t").toString(), "Oh, hello world", "the page got what changed since the save");

  // From here, an edit goes straight down the socket.
  provider.doc.getText("t").insert(0, "> ");
  assert.deepEqual(frames(socket), [MESSAGE_SYNC]);
  theRoom.exchange();
  assert.equal(server.getText("t").toString(), "> Oh, hello world");
  provider.destroy();
});

test("without a saved state the document starts empty and is not seeded, and the room's copy fills it", (t) => {
  FakeSocket.instances = [];
  const server = new Y.Doc();
  server.getText("t").insert(0, "from the room");
  const provider = new FolioProvider("wss://g1t.test/acme/-/artifacts/live?folio=f2", { state: null });
  t.after(() => provider.destroy());
  assert.equal(provider.seeded, false);
  const socket = FakeSocket.instances[0]!;
  socket.readyState = FakeSocket.OPEN;
  socket.onopen?.();
  const theRoom = room(server, socket);
  theRoom.exchange();
  assert.equal(provider.status, "synced");
  assert.equal(provider.doc.getText("t").toString(), "from the room");
  provider.destroy();
});

test("a state that is not a Yjs update is ignored, and the provider waits for the room as before", (t) => {
  FakeSocket.instances = [];
  const provider = new FolioProvider("wss://g1t.test/acme/-/artifacts/live?folio=f3", { state: new Uint8Array([1, 2, 3, 4, 5, 6, 7]) });
  t.after(() => provider.destroy());
  assert.equal(provider.seeded, false);
  provider.destroy();
});

test("the page's base64 state becomes bytes, and anything else becomes nothing", (t) => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
  assert.deepEqual(pageStateBytes(btoa(String.fromCharCode(...bytes))), bytes);
  assert.equal(pageStateBytes(null), null);
  assert.equal(pageStateBytes(""), null);
  assert.equal(pageStateBytes("not base64!"), null);
});
