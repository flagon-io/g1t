import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { build } from "esbuild";

// Execute the real service code against SQLite, with only the Cloudflare host replaced.
async function service(path) {
  const bundle = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "worker-host",
        setup(build) {
          build.onResolve({ filter: /^yjs$/ }, () => ({ path: import.meta.resolve("yjs"), external: true }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "host" }));
          build.onLoad({ filter: /.*/, namespace: "host" }, () => ({
            contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
          }));
        },
      },
    ],
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

function database(service) {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL(`../services/${service}/migrations/`, import.meta.url);
  for (const name of readdirSync(dir).sort()) raw.exec(readFileSync(new URL(name, dir), "utf8"));
  raw.exec("PRAGMA foreign_keys = ON");
  const run = (s) => ({ meta: { changes: Number(raw.prepare(s.sql).run(...s.params).changes) } });
  const prepare = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => prepare(sql, p),
    first: async () => raw.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...params) }),
    run: async () => run({ sql, params }),
  });
  return {
    raw,
    prepare,
    batch: async (statements) => {
      raw.exec("BEGIN");
      try {
        const result = statements.map(run);
        raw.exec("COMMIT");
        return result;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
const namespace = (get) => ({ idFromName: (id) => id, get });
const AT = "2026-10-14T00:00:00.000Z";

test("identity purge work is atomic, idempotent and a prior restore prevents scheduling", () => {
  const db = database("identity").raw;
  const enqueue = db.prepare(readFileSync(new URL("../services/identity/src/purge_job.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO users (id, username, password_hash, created_at, deleted_at, purge_after) VALUES ('usr_fixture', 'fixture', 'fixture', ?, ?, ?)").run(
    AT,
    AT,
    AT,
  );
  const args = { "?1": "usr_fixture", "?2": "user", "?3": "CHAT", "?4": "{}", "?5": AT };
  db.exec("BEGIN");
  enqueue.run(args);
  db.exec("DELETE FROM users WHERE id = 'usr_fixture'");
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT count(*) n FROM purge_jobs").get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM users WHERE id = 'usr_fixture'").get());
  db.exec("UPDATE users SET deleted_at = NULL, purge_after = NULL WHERE id = 'usr_fixture'");
  enqueue.run(args);
  assert.equal(db.prepare("SELECT count(*) n FROM purge_jobs").get().n, 0);
  db.prepare("UPDATE users SET deleted_at = ?, purge_after = ? WHERE id = 'usr_fixture'").run(AT, AT);
  db.exec("BEGIN");
  enqueue.run(args);
  enqueue.run(args);
  db.exec("DELETE FROM users WHERE id = 'usr_fixture'; COMMIT");
  assert.equal(db.prepare("SELECT count(*) n FROM purge_jobs").get().n, 1);
  assert.equal(db.prepare("SELECT completed_at FROM purge_jobs").get().completed_at, null);
});

test("chat purges the private AI conversation, preserves other tenants, retries failed rooms and rejects late writes", async () => {
  const { purgePersonalData } = await service("services/chat/src/erasure.ts");
  const db = database("chat");
  const { G1T_KEY } = await service("packages/contracts/src/chat.ts");
  for (const [id, person] of [
    ["mine", "usr_a"],
    ["other", "usr_b"],
  ]) {
    db.raw.prepare("INSERT INTO channels (id, workspace_id, kind, created_by, created_at) VALUES (?, ?, 'dm', ?, ?)").run(id, id, `user:${person}`, AT);
    for (const key of [`user:${person}`, G1T_KEY])
      db.raw.prepare("INSERT INTO channel_members (channel_id, principal, joined_at) VALUES (?, ?, ?)").run(id, key, AT);
    db.raw.prepare("INSERT INTO messages (id, channel_id, author, body, created_at) VALUES (?, ?, ?, 'private prompt', ?)").run(id, id, `user:${person}`, AT);
  }
  let fail = true;
  const env = {
    DB: db,
    ROOMS: namespace(() => ({
      erase: async () => {
        if (fail) throw Error("unavailable");
      },
    })),
    AVATARS: { delete: async () => {} },
  };
  await assert.rejects(purgePersonalData(env, { kind: "user", id: "usr_a" }));
  assert.equal(db.raw.prepare("SELECT count(*) n FROM messages").get().n, 2);
  fail = false;
  assert.deepEqual(await purgePersonalData(env, { kind: "user", id: "usr_a" }), { ok: true });
  assert.deepEqual(await purgePersonalData(env, { kind: "user", id: "usr_a" }), { ok: true });
  assert.equal(db.raw.prepare("SELECT count(*) n FROM messages").get().n, 1);
  assert.equal(db.raw.prepare("SELECT body FROM messages WHERE id = 'other'").get().body, "private prompt");
  db.raw.prepare("INSERT INTO messages (id, channel_id, author, body, created_at) VALUES ('late', 'mine', 'user:usr_a', 'late', ?)").run(AT);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM messages").get().n, 1);
});

test("artifacts keep retry references when file deletion fails, then remove private state with FK enforcement", async () => {
  const { purgePersonalData } = await service("services/artifacts/src/erasure.ts");
  const db = database("artifacts");
  for (const [id, owner] of [
    ["mine", "usr_a"],
    ["other", "usr_b"],
  ]) {
    db.raw
      .prepare(
        "INSERT INTO folios (id, workspace_id, kind, owner, position, acl_root, path, created_by, created_at, updated_at, edited_at) VALUES (?, ?, 'doc', ?, 1, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, id, `user:${owner}`, id, `/${id}/`, `user:${owner}`, AT, AT, AT);
    db.raw
      .prepare(
        "INSERT INTO folio_files (id, workspace_id, folio_id, key, name, content_type, bytes, created_by, created_at) VALUES (?, ?, ?, ?, 'private.txt', 'text/plain', 10, ?, ?)",
      )
      .run(id, id, id, id, `user:${owner}`, AT);
  }
  let fail = true;
  const deleted = [],
    rooms = [];
  const env = {
    DB: db,
    FOLIOS: namespace((id) => ({
      forgetPerson: async () => {},
      destroy: async () => {
        rooms.push(id);
      },
    })),
    FILES: {
      delete: async (key) => {
        if (fail) throw Error("storage down");
        deleted.push(key);
      },
    },
  };
  await assert.rejects(purgePersonalData(env, { kind: "user", id: "usr_a" }));
  assert.equal(db.raw.prepare("SELECT count(*) n FROM folio_files").get().n, 2);
  fail = false;
  assert.deepEqual(await purgePersonalData(env, { kind: "user", id: "usr_a" }), { ok: true });
  assert.deepEqual(await purgePersonalData(env, { kind: "user", id: "usr_a" }), { ok: true });
  assert.deepEqual(deleted, ["docs/mine"]);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM folios").get().n, 1);
  assert.equal(db.raw.prepare("SELECT id FROM folio_files").get().id, "other");
  assert.ok(rooms.every((id) => id === "mine"));
  assert.deepEqual(await purgePersonalData(env, { kind: "workspace", id: "other" }), { ok: true });
  assert.equal(db.raw.prepare("SELECT count(*) n FROM folios").get().n, 0);
});

function objectState() {
  const raw = new DatabaseSync(":memory:");
  const kv = new Map();
  const sql = {
    exec(query, ...params) {
      const stmt = raw.prepare(query);
      if (stmt.columns().length) {
        const rows = stmt.all(...params);
        return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
      }
      const result = stmt.run(...params);
      return { toArray: () => [], rowsWritten: Number(result.changes) };
    },
  };
  return {
    raw,
    blockConcurrencyWhile: (fn) => fn(),
    storage: {
      sql,
      get: async (key) => kv.get(key),
      put: async (key, value) => {
        kv.set(key, value);
      },
      delete: async (key) => kv.delete(key),
      deleteAlarm: async () => {},
      transactionSync(fn) {
        raw.exec("BEGIN");
        try {
          fn();
          raw.exec("COMMIT");
        } catch (e) {
          raw.exec("ROLLBACK");
          throw e;
        }
      },
    },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
    waitUntil: () => {},
  };
}

test("notification erasure retries presence cleanup, clears credentials and permanently blocks late delivery", async () => {
  globalThis.WebSocketRequestResponsePair = class {};
  const { Feed } = await service("services/notify/src/feed.ts");
  const state = objectState();
  let fail = true,
    calls = 0;
  const feed = new Feed(state, {
    ROOMS: namespace(() => ({
      forget: async () => {
        calls++;
        if (fail) throw Error("offline");
      },
    })),
  });
  state.raw.exec(
    `INSERT INTO meta VALUES ('workspaces', '["acme"]'); INSERT INTO devices VALUES ('token', 'ios', 'phone', 1); INSERT INTO notifications VALUES ('n', 1, '{}');`,
  );
  await assert.rejects(feed.erase("usr_a"));
  // A late delivery is dropped quietly, never refused: senders would log and retry it.
  assert.deepEqual(await feed.deliver([{ workspace: "acme", notification: { id: "late", created_at: AT } }]), { ok: true });
  assert.deepEqual(await feed.notify({ id: "late", kind: "mention", workspace: "acme", created_at: AT }), { ok: true });
  fail = false;
  assert.deepEqual(await feed.erase("usr_a"), { ok: true });
  assert.equal(calls, 2);
  for (const table of ["devices", "notifications", "counts", "subscriptions", "visits", "watching"])
    assert.equal(state.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.deepEqual(
    state.raw
      .prepare("SELECT key FROM meta")
      .all()
      .map((r) => r.key),
    ["erased"],
  );
  await assert.rejects(feed.registerDevice({ token: "late", platform: "ios" }), /Account erased/);
  assert.equal((await feed.fetch(new Request("https://test/live"))).status, 410);
  assert.deepEqual(await feed.erase("usr_a"), { ok: true });
});

test("destroyed document rooms reject late ensure calls and keep only a tombstone", async () => {
  globalThis.WebSocketRequestResponsePair = class {};
  for (const [file, name, init] of [
    ["services/artifacts/src/room.ts", "PageRoom", { page_id: "p", workspace_slug: "acme", markdown: "private" }],
    ["services/artifacts/src/folios/room.ts", "FolioRoom", { folio_id: "f", kind: "doc", workspace_slug: "acme", text: "private" }],
  ]) {
    const module = await service(file),
      state = objectState();
    const room = new module[name](state, {});
    state.raw.exec("INSERT INTO meta VALUES ('workspace_slug', '\"acme\"'); INSERT INTO snapshot VALUES (1, x'01');");
    await room.destroy();
    await room.destroy();
    assert.equal(state.raw.prepare("SELECT count(*) n FROM snapshot").get().n, 0);
    assert.deepEqual(
      state.raw
        .prepare("SELECT key FROM meta")
        .all()
        .map((r) => r.key),
      ["erased"],
    );
    await assert.rejects(room.ensure(init), /Document erased/);
    assert.equal((await room.fetch(new Request("https://test/live"))).status, 410);
    assert.deepEqual(
      state.raw
        .prepare("SELECT key FROM meta")
        .all()
        .map((r) => r.key),
      ["erased"],
    );
  }
});

test("erasing one member of a shared channel leaves everyone else's conversation alone", async () => {
  const { purgePersonalData } = await service("services/chat/src/erasure.ts");
  const db = database("chat");
  db.raw
    .prepare("INSERT INTO channels (id, workspace_id, kind, name, created_by, created_at) VALUES ('general', 'ws', 'channel', 'general', 'user:usr_a', ?)")
    .run(AT);
  for (const person of ["usr_a", "usr_b"])
    db.raw.prepare("INSERT INTO channel_members (channel_id, principal, joined_at) VALUES ('general', ?, ?)").run(`user:${person}`, AT);
  db.raw
    .prepare(
      "INSERT INTO messages (id, channel_id, author, body, created_at) VALUES ('m1', 'general', 'user:usr_a', 'from a', ?), ('m2', 'general', 'user:usr_b', 'from b', ?)",
    )
    .run(AT, AT);
  db.raw
    .prepare("INSERT INTO reactions (message_id, principal, emoji, created_at) VALUES ('m2', 'user:usr_a', 'ok', ?), ('m2', 'user:usr_b', 'ok', ?)")
    .run(AT, AT);
  const erased = [];
  const env = {
    DB: db,
    ROOMS: namespace(() => ({
      erase: async (id, principal) => {
        erased.push([id, principal]);
      },
    })),
    AVATARS: { delete: async () => {} },
  };
  assert.deepEqual(await purgePersonalData(env, { kind: "user", id: "usr_a" }), { ok: true });
  // The room shuts out only the erased person; it is never cleared for everyone.
  assert.deepEqual(erased, [["general", "user:usr_a"]]);
  assert.deepEqual(
    db.raw
      .prepare("SELECT id, author, body FROM messages ORDER BY id")
      .all()
      .map((r) => ({ ...r })),
    [
      { id: "m1", author: "user:usr_ghost", body: "from a" },
      { id: "m2", author: "user:usr_b", body: "from b" },
    ],
  );
  assert.deepEqual(
    db.raw
      .prepare("SELECT principal FROM channel_members")
      .all()
      .map((r) => r.principal),
    ["user:usr_b"],
  );
  assert.deepEqual(
    db.raw
      .prepare("SELECT principal FROM reactions")
      .all()
      .map((r) => r.principal),
    ["user:usr_b"],
  );
  assert.equal(db.raw.prepare("SELECT created_by FROM channels").get().created_by, "user:usr_ghost");
});

test("a shared channel's room shuts out only the erased member and tells nobody it was cleared", async () => {
  globalThis.WebSocketRequestResponsePair = class {};
  const { ChannelRoom } = await service("services/chat/src/room.ts");
  const state = objectState();
  const socket = (who) => ({
    who,
    sent: [],
    closed: null,
    send(text) {
      this.sent.push(text);
    },
    close(code) {
      this.closed = code;
    },
  });
  const sockets = [socket("user:usr_a"), socket("user:usr_b")];
  state.getWebSockets = (tag) => sockets.filter((s) => !tag || s.who === tag);
  await state.storage.put("job", { message: { id: "answer_for_b" } });
  const deletes = [];
  const room = new ChannelRoom(state, {
    DB: {
      prepare: () => ({
        bind: (id) => ({
          run: async () => {
            deletes.push(id);
          },
        }),
      }),
    },
  });
  await room.erase("general", "user:usr_a");
  assert.equal(sockets[0].closed, 4403);
  assert.equal(sockets[1].closed, null);
  assert.deepEqual(sockets[1].sent, []);
  // Someone else's pending answer carries on.
  assert.deepEqual(await state.storage.get("job"), { message: { id: "answer_for_b" } });
  assert.deepEqual(deletes, []);
  assert.equal((await room.fetch(new Request("https://test/live"))).status, 426);
});

test("a workspace's large channel is deleted in chunks across calls, and nothing of it comes back", async () => {
  const { purgePersonalData } = await service("services/chat/src/erasure.ts");
  const db = database("chat");
  db.raw
    .prepare(
      "INSERT INTO channels (id, workspace_id, kind, name, created_by, created_at) VALUES ('big', 'ws', 'channel', 'big', 'user:usr_a', ?), ('kept', 'other', 'channel', 'kept', 'user:usr_b', ?)",
    )
    .run(AT, AT);
  const insert = db.raw.prepare("INSERT INTO messages (id, channel_id, author, body, created_at) VALUES (?, ?, 'user:usr_a', 'x', ?)");
  for (let i = 0; i < 5600; i++) insert.run(`m${String(i).padStart(5, "0")}`, "big", AT);
  insert.run("other", "kept", AT);
  const env = { DB: db, ROOMS: namespace(() => ({ erase: async () => {} })), AVATARS: { delete: async () => {} } };
  assert.deepEqual(await purgePersonalData(env, { kind: "workspace", id: "ws" }), { ok: false, pending: true });
  assert.ok(db.raw.prepare("SELECT count(*) n FROM messages WHERE channel_id = 'big'").get().n > 0);
  assert.deepEqual(await purgePersonalData(env, { kind: "workspace", id: "ws" }), { ok: true });
  assert.equal(db.raw.prepare("SELECT count(*) n FROM messages WHERE channel_id = 'big'").get().n, 0);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM channels WHERE workspace_id = 'ws'").get().n, 0);
  assert.equal(db.raw.prepare("SELECT body FROM messages WHERE id = 'other'").get().body, "x");
  db.raw
    .prepare("INSERT INTO channels (id, workspace_id, kind, name, created_by, created_at) VALUES ('late', 'ws', 'channel', 'late', 'user:usr_b', ?)")
    .run(AT);
  db.raw.prepare("INSERT INTO chat_settings (workspace_id) VALUES ('ws')").run();
  assert.equal(db.raw.prepare("SELECT count(*) n FROM channels WHERE workspace_id = 'ws'").get().n, 0);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM chat_settings").get().n, 0);
});

test("a purged workspace's slug can be made again: only what was said before the purge is dropped", async () => {
  globalThis.WebSocketRequestResponsePair = class {};
  const { Feed } = await service("services/notify/src/feed.ts");
  const { Room } = await service("services/notify/src/room.ts");
  const state = objectState();
  const feed = new Feed(state, {});
  const before = new Date(Date.now() - 60_000).toISOString();
  state.raw.prepare("INSERT INTO notifications VALUES ('old', 1, ?)").run(JSON.stringify({ id: "old", workspace: "alice", created_at: before }));
  state.raw.prepare("INSERT INTO meta VALUES ('complete:alice', '1'), ('forgot:alice:ch_1', ?), ('forgot:alicex:ch_1', ?)").run(before, before);
  assert.deepEqual(await feed.eraseWorkspace("alice"), { ok: true });
  assert.equal(state.raw.prepare("SELECT count(*) n FROM notifications").get().n, 0);
  assert.deepEqual(
    state.raw
      .prepare("SELECT key FROM meta WHERE key LIKE 'forgot:%' OR key LIKE 'complete:%'")
      .all()
      .map((r) => r.key),
    ["forgot:alicex:ch_1"],
  );
  // A late notification from before the purge is dropped; one from the workspace made again is kept.
  await feed.notify({ id: "late", kind: "mention", workspace: "alice", title: "t", url: "/alice", created_at: before });
  await feed.notify({ id: "new", kind: "mention", workspace: "alice", title: "t", url: "/alice", created_at: new Date(Date.now() + 1000).toISOString() });
  assert.deepEqual(
    state.raw
      .prepare("SELECT id FROM notifications")
      .all()
      .map((r) => r.id),
    ["new"],
  );

  const room = new Room(objectState(), {});
  await room.report("alice", { user_id: "usr_b", at: 1, presence: "online" });
  assert.deepEqual(await room.eraseMembers(), ["usr_b"]);
  await room.dropPerson("usr_b");
  assert.equal(await room.report("alice", { user_id: "usr_c", at: 2, presence: "online" }), null);
  await room.report("alice", { user_id: "usr_b", at: Date.now() + 1000, presence: "online" });
  assert.deepEqual(
    (await room.people()).map((p) => p.user_id),
    ["usr_b"],
  );
});

test("vectors written while a document was being erased are taken back", async () => {
  const { dropIfErased, erasedSource } = await service("services/artifacts/src/indexer.ts");
  const db = database("artifacts");
  const deleted = [];
  const store = {
    delete: async (ids) => {
      deleted.push(...ids);
    },
  };
  await dropIfErased(db, store, "folio", "f1", "ws", ["f1:0"]);
  assert.deepEqual(deleted, []);
  db.raw.prepare("INSERT INTO erased_documents (id, kind) VALUES ('f1', 'folio')").run();
  assert.equal(await erasedSource(db, "folio", "f1", "ws"), true);
  assert.equal(await erasedSource(db, "page", "f1", "ws"), false);
  await dropIfErased(db, store, "folio", "f1", "ws", ["f1:0", "f1:1"]);
  assert.deepEqual(deleted, ["f1:0", "f1:1"]);
  db.raw.prepare("INSERT INTO erased_subjects VALUES ('ws2', 'workspace')").run();
  assert.equal(await erasedSource(db, null, "repo_file", "ws2"), true);
});

test("a workspace's uploads are swept a page at a time, resuming after a failure", async () => {
  const { purgePersonalData } = await service("services/artifacts/src/erasure.ts");
  const db = database("artifacts");
  const insert = db.raw.prepare(
    "INSERT INTO files (id, workspace_id, page_id, key, name, content_type, bytes, created_by, created_at) VALUES (?, ?, NULL, ?, 'f', 'text/plain', 1, 'user:usr_a', ?)",
  );
  for (let i = 0; i < 2100; i++) insert.run(`f${i}`, "ws", `k${i}`, AT);
  insert.run("kept", "other", "kept", AT);
  let fail = 3;
  const deleted = new Set();
  const env = {
    DB: db,
    FILES: {
      delete: async (key) => {
        if (key === "docs/k5" && fail-- > 0) throw Error("storage down");
        deleted.add(key);
      },
    },
  };
  await assert.rejects(purgePersonalData(env, { kind: "workspace", id: "ws" }));
  let result;
  for (let i = 0; i < 6 && !result?.ok; i++) result = await purgePersonalData(env, { kind: "workspace", id: "ws" }).catch(() => null);
  assert.deepEqual(result, { ok: true });
  assert.equal(deleted.size, 2100);
  assert.ok(!deleted.has("docs/kept"));
  assert.equal(db.raw.prepare("SELECT id FROM files").get().id, "kept");
});
