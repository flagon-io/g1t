import assert from "node:assert/strict";
import { test } from "node:test";

import type { FolioRef, User } from "@g1t/contracts";

import { FOUNDATIONAL_SKILLS, FOUNDATIONAL_SKILL_IDS, skillTools, skillsOn } from "../../../packages/contracts/src/skills.ts";
import { Audience, type AudienceInfo } from "./audience.ts";
import { applyChanges } from "./definition.ts";
import { systemPrompt } from "./prompt.ts";
import { skillsSection } from "./skills.ts";
import { TEMPLATE_IDS } from "./templates.ts";
import { type FoliosPorts, type ToolPorts, TOOL_NAMES, ToolBox, docBody } from "./tools.ts";

test("the foundational skills name only tools agents have, and say what's coming", () => {
  assert.deepEqual(FOUNDATIONAL_SKILL_IDS, ["documents", "research", "data", "code", "communication", "files"]);
  for (const skill of FOUNDATIONAL_SKILLS) {
    assert.equal(skill.source, "foundational");
    assert.ok(skill.instructions.length > 100, `${skill.id} has a playbook`);
    for (const ability of skill.abilities) {
      for (const tool of ability.tools) assert.ok(TOOL_NAMES.has(tool), `${skill.id}/${ability.id} names ${tool}, which agents have`);
      if (ability.status === "coming") assert.deepEqual(ability.tools, [], `${skill.id}/${ability.id} is coming, so it uses no tool yet`);
      assert.ok(ability.note, `${skill.id}/${ability.id} says how or what's missing`);
    }
    // Every tool a playbook tells the agent to call is one it can have.
    for (const [, tool] of skill.instructions.matchAll(/\b([a-z]+_[a-z_]+)\b/g)) assert.ok(TOOL_NAMES.has(tool!), `${skill.id}'s playbook names ${tool}`);
  }
  assert.ok(skillTools(FOUNDATIONAL_SKILLS[0]!).includes("make_file"));
  const coming = FOUNDATIONAL_SKILLS.flatMap((s) => s.abilities.filter((a) => a.status === "coming").map((a) => a.id));
  for (const id of ["slides", "search", "browse", "sql", "run", "schedule", "ocr", "images"]) assert.ok(coming.includes(id), `${id} is marked coming`);
});

test("each skill that is on puts its playbook in the prompt, with what isn't here and what's coming", () => {
  const all = [...TOOL_NAMES];
  const section = skillsSection([], all)!;
  for (const skill of FOUNDATIONAL_SKILLS) assert.match(section, new RegExp(`### ${skill.name}\\n`));
  assert.match(section, /they never add one/);
  assert.match(section, /Not yet in g1t: slide decks\./);
  assert.match(section, /Not yet in g1t: search the web and browse and read pages\./);
  assert.doesNotMatch(section, /Not available in this conversation/, "every tool is offered");
  // In a conversation whose people can't all read code: the code abilities say so.
  const noCode = skillsSection([], all.filter((t) => !["list_repositories", "search_code", "read_file", "recent_activity", "get_pull", "review_pull", "comment", "draft_issue"].includes(t)))!;
  assert.match(noCode, /### Code[\s\S]*Not available in this conversation \(its tools aren't offered here\): read and explain code, review pull requests and open pull requests\./);
  // Off: gone from the prompt, the rest stays.
  const someOff = skillsSection(["communication", "files"], all)!;
  assert.doesNotMatch(someOff, /### Communication/);
  assert.doesNotMatch(someOff, /### Files and media/);
  assert.match(someOff, /### Documents/);
  assert.equal(skillsSection(FOUNDATIONAL_SKILL_IDS, all), null);
  assert.equal(skillsOn(["data"]).length, 5);
  const prompt = systemPrompt({
    agent: { id: "agt_1", handle: "ship", display_name: "Ship", role: "Release manager", instructions: "Ship.", personality_preset: "crisp", personality: "" },
    workspace: "acme",
    channel: { kind: "dm", name: null },
    asker: { name: "dana", display_name: null, access: null },
    today: new Date("2026-10-10T00:00:00Z"),
    skills: section,
  });
  assert.ok(prompt.indexOf("## Your skills") > prompt.indexOf("## How to answer"), "skills come after the rules");
});

test("owners turn skills off by id; unknown ids are refused, and the list reads in the skills' order", () => {
  const made = applyChanges(null, { handle: "ship", display_name: "Ship", role: "r", instructions: "i" }, TEMPLATE_IDS);
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.deepEqual(made.value.skills_off, []);
  const off = applyChanges(made.value, { skills_off: ["files", " data ", "files"] }, TEMPLATE_IDS);
  assert.ok(off.ok);
  assert.deepEqual(off.ok && off.value.skills_off, ["data", "files"]);
  const bad = applyChanges(made.value, { skills_off: ["teleport"] }, TEMPLATE_IDS);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /no skill called teleport/);
  assert.equal(applyChanges(made.value, { skills_off: "data" as unknown as string[] }, TEMPLATE_IDS).ok, false);
});

// ── make_file, end to end through the tool box ──────────────────────────

const person = (id: string): User => ({ id, username: id, workspaces: [{ slug: "acme", role: "member" }] }) as User;

const basePorts: ToolPorts = {
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

function fakeFolios(opts: { audienceCanRead?: boolean; canEdit?: boolean } = {}) {
  const log: { created: { title: string; markdown: string | null }[]; attached: { folio: string; name: string; type: string; bytes: number }[]; edits: string[]; links: string[] } = { created: [], attached: [], edits: [], links: [] };
  const ref = (id: string, title: string): FolioRef => ({ id, kind: "doc", title, path: `/acme/-/artifacts/${id}`, icon: null }) as unknown as FolioRef;
  const folios: FoliosPorts = {
    spaces: async () => [],
    recall: async () => [],
    search: async () => "",
    read: async (_v, _a, id) => ({
      ok: true,
      value: { folio: { ...ref(id, "Existing"), edited_at: "2026-10-10" }, space: null, content: "", can: { read: true, suggest: true, edit: opts.canEdit ?? true }, audience_can_read: opts.audienceCanRead ?? true } as never,
    }),
    stale: async () => "",
    create: async (_v, input) => {
      log.created.push({ title: input.title, markdown: input.markdown });
      return { ok: true, value: ref("fol_new", input.title) };
    },
    edit: async (_v, _id, edit) => {
      log.edits.push(edit.kind === "doc" ? edit.markdown : "");
      return { ok: true, value: { mode: "applied", version_id: null, folio: ref("fol_new", "x"), summary: "" } };
    },
    share: async () => ({ ok: true, value: null }),
    attach: async (_v, folio, file) => {
      log.attached.push({ folio, name: file.name, type: file.content_type, bytes: file.bytes.length });
      return { ok: true, value: { url: "https://g1tusercontent.com/docs-files/abc", name: file.name, bytes: file.bytes.length } };
    },
    sendLink: async (_a, link) => {
      log.links.push(link.path);
      return true;
    },
  };
  return { folios, log };
}

const actions = { remember: async () => ({ ok: true, message: "" }), forget: async () => ({ ok: true, message: "" }), draftIssue: async () => ({ ok: true, message: "" }) };
const context = { agentId: "agt_me", notConsult: [], hops: 0, maxHops: 4 };

async function box(info: AudienceInfo, folios: FoliosPorts) {
  const people = [person("asker"), person("bea")];
  const audience = await Audience.build("acme", "asker", {
    info: async () => info,
    users: async (ids) => people.filter((u) => ids.includes(u.id)),
    workspaceRepos: async () => [],
    readable: async () => [],
  });
  return new ToolBox(audience, { ...basePorts, folios }, context, [], actions);
}

test("make_file makes the PDF, keeps it with a new doc holding its text, links it, and hands back the link", async () => {
  const { folios, log } = fakeFolios();
  const tools = await box({ kind: "dm", member_user_ids: ["asker"], member_count: 1 }, folios);
  assert.ok(tools.definitions().some((t) => t.name === "make_file"));
  const result = await tools.run("make_file", { format: "pdf", title: "Q3 report", content: "# Q3 report\n\nRevenue grew." });
  assert.equal(result.outcome, "allowed");
  assert.match(result.text, /Made Q3 report\.pdf \(1 page, \d+ KB\)/);
  assert.match(result.text, /https:\/\/g1tusercontent\.com\/docs-files\/abc/);
  assert.deepEqual(log.created, [{ title: "Q3 report", markdown: "Revenue grew." }], "the doc has its own title, so the heading isn't repeated");
  assert.equal(log.attached[0]!.type, "application/pdf");
  assert.equal(log.attached[0]!.folio, "fol_new");
  assert.match(log.edits[0]!, /^\*\*File:\*\* \[Q3 report\.pdf\]\(https:\/\/g1tusercontent\.com\/docs-files\/abc\)/);
});

test("make_file attaches to a doc only where it may edit, and keeps a doc others here can't read out of the conversation", async () => {
  const readOnly = fakeFolios({ canEdit: false });
  const tools = await box({ kind: "dm", member_user_ids: ["asker"], member_count: 1 }, readOnly.folios);
  const refused = await tools.run("make_file", { format: "csv", title: "Rows", sheets: [{ rows: [["a"], [1]] }], artifact: "fol_01k7a0b1c2d3e4f5g6h7j8k9mn" });
  assert.equal(refused.outcome, "refused");
  assert.match(refused.text, /can.t edit that doc/);
  assert.equal(readOnly.log.attached.length, 0);

  const hidden = fakeFolios({ audienceCanRead: false });
  const group = await box({ kind: "private", member_user_ids: ["asker", "bea"], member_count: 2 }, hidden.folios);
  const sent = await group.run("make_file", { format: "xlsx", title: "Salaries", sheets: [{ rows: [["name", "pay"], ["bea", 1]] }], artifact: "fol_01k7a0b1c2d3e4f5g6h7j8k9mn" });
  assert.equal(hidden.log.attached.length, 1, `kept with the doc: ${sent.text}`);
  assert.doesNotMatch(sent.text, /docs-files/, "the link isn't given here");
  assert.deepEqual(hidden.log.links, ["/acme/-/artifacts/fol_01k7a0b1c2d3e4f5g6h7j8k9mn"], "the person who asked gets it directly");
});

test("a spreadsheet's doc shows its rows; a format it can't write is refused with what to do instead", async () => {
  assert.match(docBody("xlsx", "Sales", { sheets: [{ name: "S", rows: [["a", "b"], [1, 2]] }] }), /^\| a \| b \|/);
  assert.equal(docBody("pdf", "T", { content: "# T" }), "The file is attached below.");
  const { folios } = fakeFolios();
  const tools = await box({ kind: "dm", member_user_ids: ["asker"], member_count: 1 }, folios);
  const deck = await tools.run("make_file", { format: "pptx", title: "Deck" });
  assert.equal(deck.outcome, "refused");
  assert.match(deck.text, /offer a PDF or a doc instead/);
});
