import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureBuiltin } from "./builtin.ts";
import { applyChanges } from "./definition.ts";
import {
  BUILTIN_NO_MODEL,
  type Specialist,
  builtinChanges,
  builtinDefinition,
  capMentions,
  orchestratorInstructions,
  orchestratorTier,
  rosterLines,
} from "./orchestrator.ts";
import { replyModel } from "./routing.ts";
import { DEFAULT_ROUTING as POLICY } from "../../runner/src/model-env.ts";

/** A stand-in D1 that records statements, and says whether an insert changed anything. */
function fakeDb(insertChanges: number) {
  const ran: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              ran.push({ sql, args });
              return { meta: { changes: sql.includes("INSERT OR IGNORE INTO agents") ? insertChanges : 1 } };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, ran };
}

test("@g1t is made once per workspace, marked builtin, with its first version", async () => {
  const memo = new Set<string>();
  const { db, ran } = fakeDb(1);
  await ensureBuiltin(db, "wsp_1", memo);
  assert.equal(ran.length, 2);
  assert.match(ran[0].sql, /INSERT OR IGNORE INTO agents/);
  const column = (name: string) => ran[0].args[ran[0].sql.slice(ran[0].sql.indexOf("(") + 1, ran[0].sql.indexOf(")")).split(", ").indexOf(name)];
  assert.equal(column("workspace_id"), "wsp_1");
  assert.equal(column("handle"), "g1t");
  assert.equal(column("template"), "orchestrator");
  assert.equal(column("builtin"), 1);
  assert.equal(column("version"), 1);
  assert.equal(column("created_by"), "g1t");
  assert.match(ran[1].sql, /INSERT INTO agent_versions/);
  await ensureBuiltin(db, "wsp_1", memo);
  assert.equal(ran.length, 2, "an isolate that has seen it made does not write again");
});

test("a workspace that has @g1t already gets no second one, and no version row", async () => {
  const { db, ran } = fakeDb(0);
  await ensureBuiltin(db, "wsp_2", new Set());
  assert.equal(ran.length, 1);
});

test("@g1t's handle, name, role and job are fixed; the rest is the workspace's", () => {
  const current = builtinDefinition();
  assert.equal(current.handle, "g1t");
  assert.equal(current.template, "orchestrator");
  // A profile form sends every field: the fixed ones are ignored, the editable ones apply.
  const form = builtinChanges(current, {
    handle: "boss",
    display_name: "Boss",
    role: "Does whatever",
    title: "",
    team: "qa",
    department: "x",
    responsibilities: [],
    subagents: [],
    template: "qa",
    faces: "customers",
    personality_preset: "terse",
    budget: { monthly_micros: 5_000_000 },
    instructions: "Be brief.",
  });
  assert.ok(form.ok);
  if (form.ok) assert.deepEqual(form.value, { personality_preset: "terse", budget: { monthly_micros: 5_000_000 }, instructions: "Be brief." });
  if (form.ok) {
    const saved = applyChanges(current, form.value, [], { builtin: true });
    assert.ok(saved.ok);
    if (saved.ok) {
      assert.equal(saved.value.handle, "g1t");
      assert.equal(saved.value.title, "Orchestrator");
      assert.equal(saved.value.personality_preset, "terse");
      assert.equal(saved.value.budget.monthly_micros, 5_000_000);
    }
  }
  // Its instructions are additions, and may be cleared.
  const cleared = applyChanges({ ...current, instructions: "Be brief." }, { instructions: "" }, [], { builtin: true });
  assert.ok(cleared.ok);
  if (cleared.ok) assert.equal(cleared.value.instructions, "");
  const limited = applyChanges(current, { budget: { monthly_micros: 10_000_000 }, routing: { ceiling: "large" }, capacity: 2 }, [], { builtin: true });
  assert.ok(limited.ok);
  assert.equal(applyChanges(current, { instructions: "" }, []).ok, false, "any other agent needs instructions");
});

const ship: Specialist = { handle: "ship", display_name: "Shipwright", role: "Release manager.", status: "idle", spent_month_micros: 1_200_000, monthly_micros: 20_000_000 };
const triage: Specialist = { handle: "triage", display_name: "triage", role: "Sorts issues", status: "out_of_budget", spent_month_micros: 5_000_000, monthly_micros: 5_000_000 };
const scribe: Specialist = { handle: "scribe", display_name: "Scribe", role: "Keeps docs true", status: "working", spent_month_micros: 0, monthly_micros: null };

test("the roster names each specialist, its role, status and spend against its cap", () => {
  assert.equal(
    rosterLines([ship, triage, scribe]),
    [
      "- @ship (Shipwright): Release manager. idle; $1.20 of $20.00 this month.",
      "- @triage: Sorts issues. out of budget; $5.00 of $5.00 this month.",
      "- @scribe: Keeps docs true. working; $0.00, no cap this month.",
    ].join("\n"),
  );
  // A display name that only differs from the handle in case is not repeated.
  assert.equal(rosterLines([]), "There are no specialists in this workspace yet.");
});

test("the orchestrator's job: decide, delegate by mention with a brief, at most two, no loops", () => {
  const job = orchestratorInstructions([ship, triage], "Always copy #releases.");
  assert.match(job, /@ship \(Shipwright\)/);
  assert.match(job, /Answer directly/);
  assert.match(job, /@mention them in this thread with a crisp brief/);
  assert.match(job, /Want me to set up a release manager/);
  assert.match(job, /at most 2 specialists in one message/);
  assert.match(job, /Never delegate in a loop/);
  assert.match(job, /out of budget or paused/);
  assert.match(job, /you only speak again if someone mentions you/);
  assert.ok(job.endsWith("### Added by this workspace\n\nAlways copy #releases."), "the workspace's additions come after the fixed job");
  assert.match(orchestratorInstructions([triage], ""), /No specialist is available right now/);
  assert.match(orchestratorInstructions([], ""), /no specialists in this workspace yet/);
});

test("past two specialists, a reply's mentions wake nobody", () => {
  const text = "@ship cut it, @triage group these, @scribe write it up, and @ship again. Ask @dana.";
  assert.equal(capMentions(text, ["ship", "triage", "scribe"]), "@ship cut it, @triage group these, scribe write it up, and @ship again. Ask @dana.");
  assert.equal(capMentions("mail me@ship.io", ["ship"]), "mail me@ship.io", "an address is not a mention");
});

test("@g1t routes a delegation call in a long thread to the large tier, held to its limits", () => {
  assert.equal(orchestratorTier(6, 3), "small");
  assert.equal(orchestratorTier(7, 3), "large");
  assert.equal(orchestratorTier(30, 0), "small", "nobody to delegate to: no decision to make");
  const limits = { floor: null, ceiling: null, pinned: null };
  assert.equal(replyModel(POLICY, limits, { start: orchestratorTier(7, 1) }).tier, "large");
  assert.equal(replyModel(POLICY, { ...limits, ceiling: "small" }, { start: "large" }).tier, "small", "its ceiling holds");
  assert.equal(replyModel(POLICY, { ...limits, floor: "frontier" }, { start: "small" }).tier, "frontier", "and its floor");
});

test("@g1t's notice without a model points to AI credit and Integrations", () => {
  assert.match(BUILTIN_NO_MODEL, /AI credit under Billing/);
  assert.match(BUILTIN_NO_MODEL, /Integrations/);
});

test("the roster shows title, team and duties, so 'QA should look' reaches Margo", () => {
  const margo: Specialist = { handle: "margo", display_name: "Margo", role: "QA", title: "QA Engineer", team: "qa", responsibilities: ["Review pull requests.", "Chase flaky checks"], status: "idle", spent_month_micros: 0, monthly_micros: 10_000_000 };
  const david: Specialist = { handle: "david", display_name: "David", role: "Sales Operations, Sales", title: "Sales Operations", department: "Sales", status: "working", spent_month_micros: 0, monthly_micros: null };
  assert.equal(
    rosterLines([margo, david]),
    [
      "- @margo: QA Engineer on the qa team. Does: Review pull requests; Chase flaky checks. idle; $0.00 of $10.00 this month.",
      "- @david: Sales Operations, Sales. working; $0.00, no cap this month.",
    ].join("\n"),
  );
});
