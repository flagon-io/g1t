import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { zip as deflateZip } from "../../../apps/web/app/lib/zip.ts";
import { type CheckedSkill, checkSkillFolder } from "../../../packages/contracts/src/skill-format.ts";
import { draftedSkill, transcriptText } from "./skill-draft.ts";
import { Library, type LibraryPorts, onPush } from "./skill-library.ts";
import { bytesBase64, readUpload, unzip } from "./skill-zip.ts";
import { zip as storedZip } from "./ooxml.ts";
import { attachedRows, shelfFrom } from "./skills.ts";

/** D1 over node's SQLite with the service's migrations: prepare, bind, first, run, all and batch. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []): any => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => ({ meta: { changes: Number(db.prepare(s.sql).run(...(s.params as never[])).changes) } }));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

const WS = "wsp_acme";
const at = new Date("2026-10-10T12:00:00Z");

async function addAgent(db: D1Database, id: string, handle: string, team: string | null = null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agents (id, workspace_id, handle, display_name, role, instructions, routing, budget, autonomy, created_by, created_at, updated_at, team)
       VALUES (?, ?, ?, ?, 'r', 'i', '{}', '{}', '{}', 'ana', ?, ?, ?)`,
    )
    .bind(id, WS, handle, handle[0]!.toUpperCase() + handle.slice(1), at.toISOString(), at.toISOString(), team)
    .run();
}

type Repo = { id: string; full: string; default_branch: string; commits: Record<string, Record<string, string>> };

function ports(over: Partial<LibraryPorts> & { repos?: Repo[]; teamList?: { slug: string; name: string; can_manage: boolean }[]; log?: string[] } = {}): LibraryPorts {
  const repos = over.repos ?? [];
  const blobs = new Map<string, string>();
  return {
    teams: async () => over.teamList ?? [{ slug: "qa", name: "QA", can_manage: false }],
    repo: async (full) => repos.find((r) => r.full === full) ?? null,
    listFiles: async (repoId, ref) => {
      const repo = repos.find((r) => r.id === repoId)!;
      const commit = ref ?? repo.default_branch;
      const files = repo.commits[commit];
      if (!files) return { commit: null, files: [], truncated: false };
      return {
        commit: `${commit}-sha`,
        files: Object.entries(files).map(([path, content]) => {
          const hash = `h:${content.length}:${path}:${content}`;
          blobs.set(hash, Buffer.from(content).toString("base64"));
          return { path, hash };
        }),
        truncated: false,
      };
    },
    blobs: async (_repoId, hashes) => hashes.map((hash) => ({ hash, data: blobs.get(hash) ?? null })),
    agentTeams: async (agent) => (agent.team ? [{ slug: agent.team, name: agent.team.toUpperCase() }] : []),
    audit: (action, name) => over.log?.push(`${action} ${name}`),
    ...over,
  };
}

function library(db: D1Database, who: { username: string; owner: boolean }, p: LibraryPorts = ports()): Library {
  return new Library({ db, workspaceId: WS, slug: "acme", viewer: { id: `usr_${who.username}`, username: who.username }, owner: who.owner, ports: p, now: at });
}

const owner = { username: "chase", owner: true };
const maintainer = { username: "mia", owner: false };
const member = { username: "bo", owner: false };
const maintainerPorts = () => ports({ teamList: [{ slug: "qa", name: "QA", can_manage: true }, { slug: "web", name: "Web", can_manage: false }] });

const notes = {
  name: "release-notes",
  description: "Use when someone asks for release notes.",
  instructions: "# Release notes\n\nGroup changes by area.",
  tools: ["recent_activity", "create_artifact"],
};

test("an owner writes a skill; every save is a version, and attachments it may change follow", async () => {
  const db = fakeD1();
  await addAgent(db, "agt_margo", "margo", "qa");
  const log: string[] = [];
  const lib = library(db, owner, ports({ log }));
  const made = await lib.save(null, notes);
  assert.ok(made.ok, !made.ok ? made.error.message : "");
  assert.equal(made.value.skill.version, 1);
  assert.equal(made.value.skill.status, "published");
  assert.deepEqual(made.value.tools, ["recent_activity", "create_artifact"]);
  assert.match(made.value.skill_md, /^---\nname: release-notes\ndescription: Use when someone asks for release notes\.\ntools: \[recent_activity, create_artifact\]\n---\n\n# Release notes/);
  assert.equal(made.value.instructions, "# Release notes\n\nGroup changes by area.");
  assert.deepEqual(made.value.skill.origin, { kind: "written" });

  const attached = await lib.attach("release-notes", "agent", "@margo");
  assert.ok(attached.ok);
  assert.deepEqual(
    attached.value.skill.attachments.map((a) => [a.scope, a.target, a.label, a.version]),
    [["agent", "margo", "@margo", 1]],
  );
  assert.equal((await lib.attach("release-notes", "agent", "margo")).ok, false, "attached there already");
  assert.ok((await lib.attach("release-notes", "workspace", null)).ok);

  // Saving the same thing again writes nothing.
  const same = await lib.save("release-notes", notes);
  assert.ok(same.ok && same.value.skill.version === 1);

  // A change: version 2, and both attachments move with it.
  const changed = await lib.save("release-notes", { ...notes, instructions: `${notes.instructions}\n\nLink every pull request.`, note: "  Links  " });
  assert.ok(changed.ok);
  assert.equal(changed.value.skill.version, 2);
  assert.deepEqual(changed.value.skill.attachments.map((a) => a.version), [2, 2]);
  assert.deepEqual(changed.value.versions.map((v) => [v.version, v.note]), [[2, "Links"], [1, null]]);
  // Without moving them: version 3, attachments stay on 2, so an update is available.
  const kept = await lib.save("release-notes", { ...notes, instructions: "# Release notes\n\nShort.", update_attachments: false });
  assert.ok(kept.ok);
  assert.deepEqual(kept.value.skill.attachments.map((a) => a.version), [2, 2]);
  const tab = await lib.agentSkills("margo");
  assert.ok(tab.ok);
  const line = tab.value.skills.find((s) => s.name === "release-notes")!;
  assert.equal(line.via, "agent", "attached to the agent itself, which wins over the workspace");
  assert.equal(line.version, "2");
  assert.equal(line.update, 3);
  assert.equal(tab.value.skills.filter((s) => s.foundational).length, 6);
  // The pin moves when someone asks; an old version can be pinned too.
  const pinned = await lib.pin("release-notes", line.attachment_id, null);
  assert.ok(pinned.ok);
  assert.equal(pinned.value.skill.attachments.find((a) => a.scope === "agent")!.version, 3);
  assert.ok((await lib.pin("release-notes", line.attachment_id, 1)).ok);
  assert.equal((await lib.pin("release-notes", line.attachment_id, 9)).ok, false);
  // An older version reads as it was.
  const v1 = await lib.detail("release-notes", 1);
  assert.ok(v1.ok && v1.value.shown === 1 && v1.value.instructions === notes.instructions);
  assert.deepEqual(log, ["create_skill release-notes", "attach_skill release-notes", "attach_skill release-notes", "update_skill release-notes", "update_skill release-notes", "pin_skill release-notes", "pin_skill release-notes"]);
});

test("the editor's checks: names, the foundational names, tools agents have, and renames", async () => {
  const db = fakeD1();
  const lib = library(db, owner);
  const bad = async (input: Partial<typeof notes>, pattern: RegExp) => {
    const result = await lib.save(null, { ...notes, ...input });
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(!result.ok ? result.error.message : "", pattern);
  };
  await bad({ name: "Release Notes" }, /lowercase letters, digits and single hyphens/);
  await bad({ name: "documents" }, /one of g1t's foundational skills/);
  await bad({ description: "" }, /needs a description/);
  await bad({ instructions: "" }, /needs instructions/);
  await bad({ tools: ["teleport"] }, /teleport, which isn't a tool agents have/);
  assert.ok((await lib.save(null, notes)).ok);
  const twice = await lib.save(null, notes);
  assert.equal(!twice.ok && twice.error.code, "conflict");
  // Files: added by path, removed by path, the rest kept.
  const withFiles = await lib.save("release-notes", { ...notes, add_files: [{ path: "resources/a.md", content: "A" }, { path: "scripts/run.sh", content: "echo" }] });
  assert.ok(withFiles.ok);
  assert.deepEqual(withFiles.value.files.map((f) => f.path), ["resources/a.md", "scripts/run.sh"]);
  assert.equal(withFiles.value.requires_computer, true, "a script needs a computer");
  const fewer = await lib.save("release-notes", { ...notes, remove_files: ["scripts/run.sh"], add_files: [{ path: "resources/a.md", content: "A2" }] });
  assert.ok(fewer.ok);
  assert.deepEqual(fewer.value.files.map((f) => [f.path, f.content]), [["resources/a.md", "A2"]]);
  assert.equal(fewer.value.requires_computer, false);
  // Renaming keeps the history.
  const renamed = await lib.save("release-notes", { ...notes, name: "changelog" });
  assert.ok(renamed.ok);
  assert.equal(renamed.value.skill.name, "changelog");
  assert.equal(renamed.value.skill.version, 4);
});

test("who may do what: owners anything, maintainers their own skills and teams, members only look", async () => {
  const db = fakeD1();
  await addAgent(db, "agt_margo", "margo", "qa");
  const asOwner = library(db, owner);
  const asMaintainer = library(db, maintainer, maintainerPorts());
  const asMember = library(db, member);

  const view = await asMember.library();
  assert.ok(view.ok);
  assert.equal(view.value.can_write, false);
  assert.deepEqual(view.value.teams, []);
  assert.equal((await asMember.save(null, notes)).ok, false);

  const mine = await asMaintainer.save(null, { ...notes, name: "qa-triage" });
  assert.ok(mine.ok);
  assert.equal(mine.value.skill.can_edit, true);
  const lib = await asMaintainer.library();
  assert.ok(lib.ok);
  assert.equal(lib.value.can_write, true);
  assert.equal(lib.value.can_manage, false);
  assert.deepEqual(lib.value.teams, [{ slug: "qa", name: "QA" }], "only the teams they maintain");
  assert.deepEqual(lib.value.agents, [], "only owners attach to agents");

  // Their team: yes. Another team, an agent, the workspace: no.
  assert.ok((await asMaintainer.attach("qa-triage", "team", "qa")).ok);
  assert.equal((await asMaintainer.attach("qa-triage", "team", "web")).ok, false);
  assert.equal((await asMaintainer.attach("qa-triage", "agent", "margo")).ok, false);
  assert.equal((await asMaintainer.attach("qa-triage", "workspace", null)).ok, false);

  // An owner's skill: a maintainer can't edit it, but can attach it to their team.
  assert.ok((await asOwner.save(null, notes)).ok);
  assert.equal((await asMaintainer.save("release-notes", { ...notes, description: "Use when x." })).ok, false);
  const theirs = await asMaintainer.attach("release-notes", "team", "qa");
  assert.ok(theirs.ok);
  assert.equal(theirs.value.skill.can_edit, false);
  // Owners attach anywhere; the maintainer can't detach the workspace-wide one.
  const wide = await asOwner.attach("release-notes", "workspace", null);
  assert.ok(wide.ok);
  const wideId = wide.value.skill.attachments.find((a) => a.scope === "workspace")!.id;
  assert.equal((await asMaintainer.detach("release-notes", wideId)).ok, false);
  // Deleting: a maintainer's own skill used only by their team, yes; an owner's, no.
  assert.equal((await asMaintainer.remove("release-notes")).ok, false);
  assert.ok((await asMaintainer.remove("qa-triage")).ok);
  assert.ok((await asOwner.remove("release-notes")).ok);
  const after = await asOwner.library();
  assert.deepEqual(after.ok && after.value.skills, []);
  // A deleted skill's name is free again.
  assert.ok((await asOwner.save(null, notes)).ok);
});

test("an agent's skills: once each, through its teams and the workspace, never past 100, published only", async () => {
  const db = fakeD1();
  await addAgent(db, "agt_margo", "margo", "qa");
  const lib = library(db, owner, ports({ teamList: [{ slug: "qa", name: "QA", can_manage: true }] }));
  assert.ok((await lib.save(null, notes)).ok);
  assert.ok((await lib.save(null, { ...notes, name: "triage", description: "Use when a bug comes in." })).ok);
  assert.ok((await lib.attach("release-notes", "team", "qa")).ok);
  assert.ok((await lib.attach("triage", "workspace", null)).ok);
  const rows = await attachedRows(db, WS, "agt_margo", ["qa"]);
  assert.deepEqual(rows.map((r) => [r.name, r.scope]).sort(), [["release-notes", "team"], ["triage", "workspace"]]);
  assert.deepEqual(await attachedRows(db, WS, "agt_margo", []).then((r) => r.map((x) => x.name)), ["triage"], "not on the team: not its skill");
  const shelf = shelfFrom([], rows).skills.filter((s) => s.kind === "library").map((s) => s.name);
  assert.deepEqual(shelf, ["release-notes", "triage"]);
  const tab = await lib.agentSkills("margo");
  assert.ok(tab.ok);
  assert.deepEqual(
    tab.value.skills.filter((s) => !s.foundational).map((s) => [s.name, s.via, s.via_label, s.on]),
    [
      ["release-notes", "team", "QA", true],
      ["triage", "workspace", "Every agent", true],
    ],
  );
});

test("uploads: a SKILL.md, a zip of its folder (stored or deflated), and what is refused", async () => {
  const skillMd = "---\nname: brand-voice\ndescription: >\n  Use when writing anything customers read:\n  posts, emails and docs.\nlicense: MIT\nmetadata:\n  author: acme\n---\n\n# Brand voice\n\nWarm, plain words.\n";
  const md = await readUpload("SKILL.md", Buffer.from(skillMd).toString("base64"));
  assert.ok(md.ok);
  const zipped = storedZip([
    ["brand-voice/SKILL.md", skillMd],
    ["brand-voice/resources/words.md", "Use: team. Avoid: synergy."],
    ["brand-voice/scripts/lint.py", "print('ok')"],
  ]);
  const stored = await unzip(zipped);
  assert.ok(stored.ok);
  assert.deepEqual(stored.ok && stored.files.map((f) => f.path).sort(), ["SKILL.md", "resources/words.md", "scripts/lint.py"], "the one folder is the skill");
  const deflated = await deflateZip([
    { path: "SKILL.md", data: new TextEncoder().encode(skillMd) },
    { path: "resources/words.md", data: new TextEncoder().encode("x ".repeat(5000)) },
    { path: "resources/logo.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) },
  ]);
  const read = await unzip(deflated);
  assert.ok(read.ok, !read.ok ? read.message : "");
  assert.equal(read.ok && read.files.find((f) => f.path === "resources/words.md")!.content.length, 10000);
  assert.equal(read.ok && read.files.find((f) => f.path === "resources/logo.png")!.encoding, "base64");

  const db = fakeD1();
  const lib = library(db, owner);
  const imported = await lib.import({ kind: "upload", filename: "brand-voice.zip", data_base64: bytesBase64(zipped) }, false);
  assert.ok(imported.ok, !imported.ok ? imported.error.message : "");
  assert.equal(imported.value.skill.description, "Use when writing anything customers read: posts, emails and docs.");
  assert.equal(imported.value.requires_computer, true, "it has scripts");
  assert.deepEqual(imported.value.extra, { license: "MIT", metadata: { author: "acme" } });
  assert.equal(imported.value.skill_md, skillMd, "kept as written");
  assert.deepEqual(imported.value.files.map((f) => [f.path, f.script]), [["resources/words.md", false], ["scripts/lint.py", true]]);
  assert.deepEqual(imported.value.skill.origin, { kind: "upload", filename: "brand-voice.zip" });
  // The same name again: refused, unless as a new version.
  const again = await lib.import({ kind: "upload", filename: "SKILL.md", data_base64: Buffer.from(skillMd.replace("Warm", "Kind")).toString("base64") }, false);
  assert.equal(!again.ok && again.error.code, "conflict");
  const replaced = await lib.import({ kind: "upload", filename: "SKILL.md", data_base64: Buffer.from(skillMd.replace("Warm", "Kind")).toString("base64") }, true);
  assert.ok(replaced.ok && replaced.value.skill.version === 2);
  // A new version from a bare SKILL.md keeps nothing else: an upload is the whole folder.
  assert.deepEqual(replaced.ok && replaced.value.files, []);

  const refuse = async (filename: string, data: Uint8Array, pattern: RegExp) => {
    const result = await lib.import({ kind: "upload", filename, data_base64: bytesBase64(data) }, false);
    assert.equal(result.ok, false, filename);
    assert.match(!result.ok ? result.error.message : "", pattern);
  };
  await refuse("notes.pdf", new Uint8Array([1, 2, 3]), /Upload a SKILL\.md, or a zip/);
  await refuse("big.zip", storedZip([["SKILL.md", skillMd], ["resources/big.txt", "x".repeat(1024 * 1024)]]), /at most 1 MB/);
  await refuse("nested.zip", storedZip([["a/SKILL.md", skillMd], ["b/x.md", "x"]]), /SKILL\.md belongs at the top of the folder, not in a/);
  await refuse("escape.zip", storedZip([["SKILL.md", skillMd], ["../x.md", "x"]]), /isn't a path a skill can hold/);
  await refuse("SKILL.md", new TextEncoder().encode("# No front-matter"), /starts with front-matter/);
});

test("from a repository: a folder at one commit, read only where the viewer can read", async () => {
  const db = fakeD1();
  const repo: Repo = {
    id: "rep_1",
    full: "acme/handbook",
    default_branch: "main",
    commits: {
      main: { "skills/oncall/SKILL.md": "---\nname: oncall\ndescription: Use when paged.\n---\n\nAcknowledge first.\n", "skills/oncall/resources/runbook.md": "Steps", "README.md": "x" },
      v1: { "skills/oncall/SKILL.md": "---\nname: oncall\ndescription: Use when paged.\n---\n\nOld.\n" },
    },
  };
  const lib = library(db, owner, ports({ repos: [repo] }));
  const made = await lib.import({ kind: "repository", repo: "acme/handbook", path: "/skills/oncall/SKILL.md", ref: "v1" }, false);
  assert.ok(made.ok, !made.ok ? made.error.message : "");
  assert.deepEqual(made.value.skill.origin, { kind: "repository", repo: "acme/handbook", path: "skills/oncall", ref: "v1", commit: "v1-sha" });
  const newer = await lib.import({ kind: "repository", repo: "acme/handbook", path: "skills/oncall" }, true);
  assert.ok(newer.ok);
  assert.equal(newer.value.skill.version, 2);
  assert.deepEqual(newer.value.files.map((f) => f.path), ["resources/runbook.md"]);
  const hidden = await lib.import({ kind: "repository", repo: "acme/secret", path: "x" }, false);
  assert.equal(!hidden.ok && hidden.error.code, "not_found");
  const noRef = await lib.import({ kind: "repository", repo: "acme/handbook", path: "skills/oncall", ref: "nope" }, false);
  assert.match(!noRef.ok ? noRef.error.message : "", /has no branch, tag or commit called nope/);
});

test("a linked repository: its .g1t/skills folders become skills, pushes update them, and they're changed only there", async () => {
  const db = fakeD1();
  await addAgent(db, "agt_margo", "margo");
  const repo: Repo = {
    id: "rep_skills",
    full: "acme/agents",
    default_branch: "main",
    commits: {
      main: {
        ".g1t/skills/triage/SKILL.md": "---\nname: triage\ndescription: Use when a bug comes in.\n---\n\nReproduce first.\n",
        ".g1t/skills/wrong/SKILL.md": "---\nname: other\ndescription: Use when.\n---\n\nx\n",
        ".g1t/skills/release-notes/SKILL.md": "---\nname: release-notes\ndescription: Use when.\n---\n\nx\n",
      },
    },
  };
  const p = ports({ repos: [repo] });
  const lib = library(db, owner, p);
  assert.ok((await lib.save(null, notes)).ok, "written in the library first");
  const linked = await lib.setMirror("acme/agents");
  assert.ok(linked.ok, !linked.ok ? linked.error.message : "");
  assert.deepEqual(linked.value.changed, ["triage"]);
  assert.equal(linked.value.problems.length, 2);
  assert.match(linked.value.problems.join("\n"), /release-notes: the library already has a skill called release-notes that isn't from this repository/);
  assert.match(linked.value.problems.join("\n"), /wrong: The folder is wrong, but its SKILL\.md is named other/);
  assert.equal(linked.value.mirror?.commit, "main-sha");
  const triage = await lib.detail("triage");
  assert.ok(triage.ok);
  assert.equal(triage.value.skill.mirrored, true);
  assert.equal(triage.value.skill.can_edit, false, "changed in the repository, not here");
  assert.equal((await lib.save("triage", { ...notes, name: "triage" })).ok, false);
  assert.ok((await lib.attach("triage", "agent", "margo")).ok);

  // A push: a new version, and its attachments follow.
  repo.commits.main![".g1t/skills/triage/SKILL.md"] = "---\nname: triage\ndescription: Use when a bug comes in.\n---\n\nReproduce first, then label.\n";
  assert.equal(await onPush(db, p, "rep_skills", at), 1);
  const pushed = await lib.detail("triage");
  assert.ok(pushed.ok);
  assert.equal(pushed.value.skill.version, 2);
  assert.deepEqual(pushed.value.skill.attachments.map((a) => a.version), [2]);
  assert.equal(pushed.value.skill.origin.kind, "mirror");
  assert.equal(await onPush(db, p, "rep_other", at), 0, "nobody follows that one");

  // Gone from the repository: kept, and editable here again.
  delete repo.commits.main![".g1t/skills/triage/SKILL.md"];
  const synced = await lib.sync();
  assert.ok(synced.ok);
  assert.match(synced.value.problems.join("\n"), /triage is no longer in the repository/);
  const kept = await lib.detail("triage");
  assert.ok(kept.ok && !kept.value.skill.mirrored && kept.value.skill.can_edit);
  // Only owners link one.
  assert.equal((await library(db, maintainer, maintainerPorts()).setMirror("acme/agents")).ok, false);
  const unlinked = await lib.setMirror(null);
  assert.ok(unlinked.ok && unlinked.value.mirror === null);
});

test("save as skill: a draft from the transcript, never attached until a person publishes it", async () => {
  const transcript = transcriptText(
    { title: "Ship the Q3 notes", goal: "Write release notes for Q3.", result: "Done: the doc is linked." },
    [
      { kind: "text", by_name: "margo", body: "Reading merged pull requests.", tool: null },
      { kind: "tool", by_name: "margo", body: '{"repo":"web"}', tool: "recent_activity" },
    ],
  );
  assert.match(transcript, /^<untrusted source="session transcript">\nSession: Ship the Q3 notes/);
  assert.match(transcript, /- used recent_activity \{"repo":"web"\}/);
  assert.match(transcript, /Report:\nDone: the doc is linked\.\n<\/untrusted>\n\nWrite the SKILL\.md\.$/);
  const long = transcriptText({ title: "t", goal: "g", result: null }, Array.from({ length: 200 }, (_, i) => ({ kind: "text", by_name: null, body: `${i} ${"x".repeat(1000)}`, tool: null })));
  assert.ok(long.length < 62_000 && long.includes("[…]"), "cut in the middle");

  const answer = "```markdown\n---\nname: release-notes\ndescription: Use when someone asks for release notes.\ntools: [recent_activity]\n---\n\n# Release notes\n\n1. Read merged pull requests.\n```";
  const drafted = draftedSkill(answer);
  assert.ok(drafted.ok);
  assert.equal(draftedSkill("Sure! Here it is.").ok, false);

  const db = fakeD1();
  const lib = library(db, owner);
  assert.ok((await lib.save(null, notes)).ok, "the name is taken, so the draft gets another");
  const asMember = library(db, member);
  const draft = await asMember.saveDraft((drafted as { ok: true; skill: CheckedSkill }).skill, { kind: "session", session_id: "ses_1", agent: "margo", title: "Ship the Q3 notes" });
  assert.ok(draft.ok, !draft.ok ? draft.error.message : "");
  assert.equal(draft.value.skill.name, "release-notes-2");
  assert.match(draft.value.skill_md, /^---\nname: release-notes-2\n/);
  assert.equal(draft.value.skill.status, "draft");
  assert.equal(draft.value.skill.can_edit, false, "a member can't publish it");
  assert.equal(draft.value.skill.can_delete, true, "but can discard their own draft");
  assert.equal((await lib.attach("release-notes-2", "workspace", null)).ok, false, "a draft can't be attached");
  assert.deepEqual(await attachedRows(db, WS, "agt_x", []), []);
  const published = await lib.save("release-notes-2", { name: "q3-notes", description: "Use when someone asks for quarterly release notes.", instructions: "# Notes\n\nRead merged pull requests.", tools: ["recent_activity"] });
  assert.ok(published.ok, !published.ok ? published.error.message : "");
  assert.equal(published.value.skill.status, "published");
  assert.equal(published.value.skill.version, 1, "published in place: a draft has no history");
  assert.deepEqual(published.value.skill.origin, { kind: "session", session_id: "ses_1", agent: "margo", title: "Ship the Q3 notes" });
  assert.ok((await lib.attach("q3-notes", "workspace", null)).ok);
});

test("limits: 100 library skills per agent", async () => {
  const db = fakeD1();
  await addAgent(db, "agt_margo", "margo");
  const lib = library(db, owner);
  for (let i = 0; i < 101; i++) {
    const checked = checkSkillFolder([{ path: "SKILL.md", content: `---\nname: s-${i}\ndescription: Use when ${i}.\n---\n\nDo ${i}.\n` }]);
    assert.ok(checked.ok);
    const saved = await lib.save(null, { name: `s-${i}`, description: `Use when ${i}.`, instructions: `Do ${i}.` });
    assert.ok(saved.ok);
    const attached = await lib.attach(`s-${i}`, i % 2 ? "agent" : "workspace", i % 2 ? "margo" : null);
    if (i < 100) assert.ok(attached.ok, `${i}: ${!attached.ok ? attached.error.message : ""}`);
    else assert.match(!attached.ok ? attached.error.message : "", /at most 100 skills from the library/);
  }
});
