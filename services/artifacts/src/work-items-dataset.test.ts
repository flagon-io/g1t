import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const dir = new URL("../migrations/", import.meta.url);
const MIGRATION = "0011_work_items_dataset.sql";

test("dashboard templates that read issues read work items after the migration, run once or twice", () => {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(dir).sort()) {
    if (file >= MIGRATION) break;
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  const insert = db.prepare(
    "INSERT INTO folio_templates (id, workspace_id, kind, name, body, created_by, created_at) VALUES (?, 'wsp_1', ?, ?, ?, 'user:usr_1', 'now')",
  );
  const tiles = [
    { id: "t1", type: "stat", query: { dataset: "issues", measure: { op: "count" } } },
    { id: "t2", type: "markdown", query: null, markdown: "Notes" },
    { id: "t3", type: "line", query: { dataset: "pull_requests", measure: { op: "count" } } },
  ];
  insert.run("tpl_1", "dashboard", "Triage", JSON.stringify({ tiles }));
  insert.run("tpl_2", "doc", "Notes", "# issues");
  insert.run("tpl_3", "dashboard", "Not JSON", "not json");
  const sql = readFileSync(new URL(MIGRATION, dir), "utf8");
  db.exec(sql);
  db.exec(sql);
  const body = (id: string) => (db.prepare("SELECT body FROM folio_templates WHERE id = ?").get(id) as { body: string }).body;
  const migrated = JSON.parse(body("tpl_1")) as { tiles: { id: string; query: { dataset: string } | null }[] };
  assert.deepEqual(
    migrated.tiles.map((tile) => [tile.id, tile.query?.dataset ?? null]),
    [
      ["t1", "work_items"],
      ["t2", null],
      ["t3", "pull_requests"],
    ],
  );
  assert.equal(body("tpl_2"), "# issues");
  assert.equal(body("tpl_3"), "not json");
});
