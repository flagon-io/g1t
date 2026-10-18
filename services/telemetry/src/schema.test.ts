import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { MIGRATIONS } from "./schema.ts";

test("an error group linked to an issue keeps its old number when issues become work items", () => {
  const db = new DatabaseSync(":memory:");
  for (const step of MIGRATIONS.slice(0, -1)) db.exec(step);
  db.exec(
    `INSERT INTO error_groups (fingerprint, name, message, service, first_us, last_us, issue_number)
     VALUES ('fp_1', 'TypeError', 'boom', 'web', 1, 2, 7), ('fp_2', 'TypeError', 'bang', 'web', 1, 2, NULL)`,
  );
  db.exec(MIGRATIONS.at(-1)!);
  const rows = db.prepare("SELECT fingerprint, item, legacy_issue FROM error_groups ORDER BY fingerprint").all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { fingerprint: "fp_1", item: null, legacy_issue: 7 },
      { fingerprint: "fp_2", item: null, legacy_issue: null },
    ],
  );
});
