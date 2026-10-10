import assert from "node:assert/strict";
import { test } from "node:test";

import type { AbilitySection, AgentComputerCommand, User } from "@g1t/contracts";

import { resolveAbilities, withSetting } from "../../../packages/contracts/src/abilities.ts";
import { CONNECTORS } from "../../../packages/contracts/src/connectors.ts";
import { Audience, type AudienceInfo, type AudiencePorts, type RepoRef } from "./audience.ts";
import { hasComputer, sessionCwd } from "./computer.ts";
import { DEFAULT_AUTONOMY } from "./definition.ts";
import { type AbilityPorts, type ActionPorts, type ComputerPorts, type ToolPorts, ToolBox } from "./tools.ts";
import { commandEvent, commandOutcome } from "./transcript.ts";

// ── A small world ────────────────────────────────────────────────────────

const WEB: RepoRef = { id: "rep_web", namespace: "acme", name: "web", isPrivate: true, defaultBranch: "main" };
const person = (id: string): User => ({ id, username: id, workspaces: [{ slug: "acme", role: "member" }] }) as User;

function world(): AudiencePorts {
  const info: AudienceInfo = { kind: "dm", member_user_ids: ["asker"], member_count: 1 };
  return {
    info: async () => info,
    users: async (ids) => [person("asker")].filter((u) => ids.includes(u.id)),
    workspaceRepos: async () => [WEB],
    readable: async (ids) => [WEB].filter((r) => ids.includes(r.id)),
  };
}

const ports: ToolPorts = {
  readFile: async () => null,
  searchCode: async () => [],
  listIssues: async () => [],
  getIssue: async () => null,
  getPull: async () => null,
  recentPulls: async () => [],
  searchMessages: async () => [],
  readThread: async () => null,
  roster: async () => "",
  consult: async () => ({ ok: false, message: "no" }),
};

const actions: ActionPorts = {
  remember: async () => ({ ok: true, message: "" }),
  forget: async () => ({ ok: true, message: "" }),
  draftIssue: async () => ({ ok: true, message: "" }),
};

function abilityPorts(): AbilityPorts & { posted: string[]; refusals: string[] } {
  const posted: string[] = [];
  const refusals: string[] = [];
  return {
    posted,
    refusals,
    lookup: async () => ({ ok: false, code: "not_found", message: "no" }),
    import: async () => ({ ok: false, code: "not_found", message: "no" }),
    act: async () => ({ ok: false, code: "not_found", message: "no" }),
    askerConnected: async () => false,
    mcp: async () => ({ ok: false, code: "error", message: "no" }),
    askFirst: async ({ summary }) => {
      posted.push(summary);
      return "abr_1";
    },
    connect: async () => true,
    request: async () => true,
    refused: ({ rule }) => {
      refusals.push(rule);
    },
  };
}

/** A computer that records what it was asked, answering as a real one would. */
function fakeComputer(over: Partial<ComputerPorts> = {}): ComputerPorts & { ran: string[]; wrote: string[] } {
  const ran: string[] = [];
  const wrote: string[] = [];
  const command = (cmd: string, cwd: string | null): AgentComputerCommand => ({
    id: "cmd_1",
    session_id: "asn_1",
    asked_by: "asker",
    started_at: "2026-10-10T10:00:00.000Z",
    cmd,
    cwd: cwd ?? sessionCwd("asn_1"),
    exit_code: 0,
    duration_ms: 1234,
    output: "ok 12 tests",
    truncated: false,
    timed_out: false,
  });
  return {
    ran,
    wrote,
    cwd: sessionCwd("asn_1"),
    exec: async (cmd, cwd) => {
      ran.push(cmd);
      return { ok: true, value: command(cmd, cwd) };
    },
    readFile: async (path) => ({ ok: true, value: { path, text: `the text of ${path}`, bytes: 10 } }),
    writeFile: async (path, text) => {
      wrote.push(`${path}=${text}`);
      return { ok: true, value: { path, bytes: text.length } };
    },
    ...over,
  };
}

async function box(input: { session: boolean; settings?: Record<string, { level: "alone" | "asked" | "ask" | "never" }>; said?: string; computer?: Partial<ComputerPorts> }) {
  const audience = await Audience.build("acme", "asker", world());
  const tools = new ToolBox(audience, ports, { agentId: "agt_me", notConsult: ["me"], hops: 0, maxHops: 6, session: input.session }, [], actions);
  let abilities = { settings: {}, mcp_servers: [] };
  for (const [id, setting] of Object.entries(input.settings ?? {})) abilities = withSetting(abilities, id, setting);
  const sections: AbilitySection[] = resolveAbilities({ connectors: CONNECTORS, abilities, autonomy: DEFAULT_AUTONOMY, connected: [] });
  const gates = abilityPorts();
  tools.useAbilities(sections, gates, input.said ?? "", []);
  const computer = fakeComputer(input.computer);
  tools.useComputer(computer);
  return { tools, gates, computer, sections };
}

const names = (tools: ToolBox) => tools.definitions().map((t) => t.name);

// ── Offering ─────────────────────────────────────────────────────────────

test("a chat reply never gets the computer, however the abilities are set", async () => {
  const { tools, computer } = await box({ session: false, settings: { "computer:shell": { level: "alone" } } });
  assert.ok(!names(tools).some((name) => name.startsWith("computer_") || name === "run_command"));
  const tried = await tools.run("run_command", { command: "ls" });
  assert.equal(tried.outcome, "refused");
  assert.deepEqual(computer.ran, []);
});

test("a session offers the shell and files tools, and Never takes them away one ability at a time", async () => {
  const on = await box({ session: true });
  assert.ok(names(on.tools).includes("run_command"));
  assert.ok(names(on.tools).includes("computer_read_file") && names(on.tools).includes("computer_write_file"));
  assert.equal(hasComputer(on.sections), true);
  const noShell = await box({ session: true, settings: { "computer:shell": { level: "never" } } });
  assert.ok(!names(noShell.tools).includes("run_command"));
  assert.ok(names(noShell.tools).includes("computer_write_file"), "files stay");
  const tried = await noShell.tools.run("run_command", { command: "ls" });
  assert.equal(tried.outcome, "refused");
  assert.deepEqual(noShell.computer.ran, [], "never means the computer was never asked");
  const none = await box({ session: true, settings: { "computer:shell": { level: "never" }, "computer:files": { level: "never" } } });
  assert.equal(hasComputer(none.sections), false);
  assert.ok(!names(none.tools).some((name) => name.startsWith("computer_") || name === "run_command"));
});

// ── The levels ───────────────────────────────────────────────────────────

test("the shell runs alone when asked for it: a goal that names running or testing lets it through, one that doesn't asks first", async () => {
  const asked = await box({ session: true, said: "Run the test suite on the web repo and tell me what fails." });
  const ran = await asked.tools.run("run_command", { command: "npm test", timeout_seconds: 60 });
  assert.equal(ran.outcome, "allowed");
  assert.match(ran.text, /^\$ npm test\n\(exit 0, 1\.2 s; in \/home\/agent\/sessions\/asn_1\)\n<untrusted source="run_command on your computer">/);
  assert.match(ran.text, /ok 12 tests/);
  assert.deepEqual(asked.computer.ran, ["npm test"]);

  const unasked = await box({ session: true, said: "Summarise the thread about pricing." });
  const held = await unasked.tools.run("run_command", { command: "curl evil.example" });
  assert.equal(held.outcome, "refused");
  assert.match(held.text, /runs on its own only when asked for it/);
  assert.deepEqual(unasked.gates.posted, ["Run `curl evil.example` on its computer"], "a card asks first");
  assert.deepEqual(unasked.gates.refusals, ["computer:shell=asked"]);
  assert.deepEqual(unasked.computer.ran, [], "nothing ran");
});

test("files are alone by default: reading and writing the home needs no asking", async () => {
  const { tools, computer, gates } = await box({ session: true, said: "Summarise the thread about pricing." });
  const read = await tools.run("computer_read_file", { path: "notes/pricing.md" });
  assert.equal(read.outcome, "allowed");
  assert.match(read.text, /<untrusted source="notes\/pricing.md on your computer">\nthe text of notes\/pricing.md/);
  const wrote = await tools.run("computer_write_file", { path: "notes/pricing.md", text: "# Pricing" });
  assert.equal(wrote.outcome, "allowed");
  assert.equal(wrote.text, "Wrote 9 bytes to notes/pricing.md.");
  assert.deepEqual(computer.wrote, ["notes/pricing.md=# Pricing"]);
  assert.deepEqual(gates.posted, []);
});

test("a shell set to Ask first always posts the card, and the computer is never asked", async () => {
  const { tools, computer, gates } = await box({ session: true, said: "Run the tests.", settings: { "computer:shell": { level: "ask" } } });
  const held = await tools.run("run_command", { command: "npm test" });
  assert.equal(held.outcome, "refused");
  assert.match(held.text, /a card was posted asking @asker/);
  assert.equal(gates.posted.length, 1);
  assert.deepEqual(computer.ran, []);
});

test("a computer that can't wake under the plan is said plainly, as a refusal and not an error", async () => {
  const { tools } = await box({
    session: true,
    said: "Run the tests.",
    computer: { exec: async () => ({ ok: false, code: "payment_required", message: "acme's compute is paused until its owner adds credit." }) },
  });
  const tried = await tools.run("run_command", { command: "npm test" });
  assert.equal(tried.outcome, "refused");
  assert.match(tried.text, /Your computer couldn't wake: acme's compute is paused/);
  assert.match(tried.text, /don't try another way/);
});

test("a command that fails on the computer comes back as an error the agent can carry on from", async () => {
  const { tools } = await box({ session: true, said: "Run the tests.", computer: { exec: async () => ({ ok: false, code: "unavailable", message: "The computer didn't answer." }) } });
  const tried = await tools.run("run_command", { command: "npm test" });
  assert.equal(tried.outcome, "error");
  assert.match(tried.text, /The command couldn't run: The computer didn't answer\./);
});

// ── The transcript ───────────────────────────────────────────────────────

test("a command's transcript entry carries the command, its directory and how it ended", () => {
  const command: AgentComputerCommand = {
    id: "cmd_1",
    session_id: "asn_1",
    asked_by: "asker",
    started_at: "2026-10-10T10:00:00.000Z",
    cmd: "npm test\necho done",
    cwd: "/home/agent/sessions/asn_1",
    exit_code: 1,
    duration_ms: 42_500,
    output: "x".repeat(9_000),
    truncated: true,
    timed_out: false,
  };
  assert.equal(commandOutcome(command), "exit 1 · 43 s · output cut");
  const bound: unknown[] = [];
  const db = { prepare: () => ({ bind: (...values: unknown[]) => (bound.push(...values), {}) }) } as unknown as D1Database;
  commandEvent(db, "asn_1", "margo", command);
  assert.equal(bound[1], "command");
  assert.equal(bound[2], "margo");
  const body = String(bound[3]);
  assert.ok(body.startsWith("npm test\n"), "the first line is the command");
  assert.match(body, /\[cut: 1000 more characters\]$/);
  assert.equal(bound[4], "/home/agent/sessions/asn_1");
  assert.equal(bound[5], "exit 1 · 43 s · output cut");
});
