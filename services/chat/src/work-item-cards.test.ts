import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const dir = new URL("../migrations/", import.meta.url);
const MIGRATION = "0008_work_item_cards.sql";

test("cards kept about issues are about work items after the migration, run once or twice", () => {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(dir).sort()) {
    if (file >= MIGRATION) break;
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  db.exec("INSERT INTO channels (id, workspace_id, kind, name, created_by, created_at) VALUES ('chn_1', 'wsp_1', 'channel', 'general', 'g1t', 'now')");
  const insert = db.prepare(
    "INSERT INTO messages (id, channel_id, author, kind, body, card, created_at) VALUES (?, 'chn_1', 'g1t', ?, '', ?, 'now')",
  );
  insert.run("msg_1", "card", JSON.stringify({ kind: "issue", title: "Header", detail: null, state: "Open", href: null }));
  insert.run("msg_2", "card", JSON.stringify({ kind: "draft_issue", title: "Draft", detail: null, state: "Draft", href: null }));
  insert.run("msg_3", "card", JSON.stringify({ kind: "pull", title: "Fix", detail: null, state: null, href: null }));
  insert.run("msg_4", "text", null);
  const sql = readFileSync(new URL(MIGRATION, dir), "utf8");
  db.exec(sql);
  db.exec(sql);
  const kinds = db
    .prepare("SELECT id, json_extract(card, '$.kind') AS kind, json_extract(card, '$.title') AS title FROM messages ORDER BY id")
    .all();
  assert.deepEqual(
    kinds.map((row) => [row.id, row.kind, row.title]),
    [
      ["msg_1", "work_item", "Header"],
      ["msg_2", "draft_work_item", "Draft"],
      ["msg_3", "pull", "Fix"],
      ["msg_4", null, null],
    ],
  );
});
