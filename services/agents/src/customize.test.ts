import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { parseMarketplaceManifest } from "../../../packages/contracts/src/claude-plugin.ts";
import { type Fetch, fetchMarketplace, fetchPlugin } from "./customize-fetch.ts";
import * as marketplaces from "./marketplaces.ts";
import * as plugins from "./plugins.ts";
import { skillByName } from "./skill-library.ts";
import { attachedRows, shelfFrom } from "./skills.ts";

/** D1, as far as Customize uses it, over node's SQLite with the service's migrations. */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as never[])) as unknown) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  const batch = async (statements: { run: () => Promise<unknown> }[]) => Promise.all(statements.map((s) => s.run()));
  return { prepare: (sql: string) => statement(sql), batch } as unknown as D1Database;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** GitHub, in miniature: a marketplace repository with two plugins, and raw files. */
const REPO: Record<string, string> = {
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: "acme-tools",
    owner: { name: "Acme" },
    metadata: { description: "Acme's tools" },
    plugins: [
      { name: "release", source: "./plugins/release", description: "Cut releases", category: "development", version: "1.2.0" },
      { name: "docs-skills", source: "./", description: "Writing skills", strict: false, skills: ["./skills/brief"] },
      { name: "from-npm", source: { source: "npm", package: "@acme/x" }, description: "Not here" },
    ],
  }),
  "plugins/release/.claude-plugin/plugin.json": JSON.stringify({ name: "release", version: "1.2.0", description: "Cuts releases", author: { name: "Acme" } }),
  "plugins/release/README.md": "# Release\n\nCuts releases.",
  "plugins/release/skills/release-notes/SKILL.md": "---\nname: release-notes\ndescription: Use when asked for release notes.\nallowed-tools: Read, Bash\n---\n\nRead the merged pull requests, group them, write the notes.\n",
  "plugins/release/skills/release-notes/references/template.md": "# Notes\n",
  "plugins/release/skills/code/SKILL.md": "---\nname: code\ndescription: A plugin skill with a foundational name.\n---\n\nIt is called release:code here.\n",
  "plugins/release/commands/cut.md": "---\ndescription: Cut a release now.\n---\n\nRun the release script.\n",
  "plugins/release/agents/releaser.md": "---\nname: releaser\ndescription: Cuts a release end to end.\ntools: Read, Bash\nmodel: sonnet\n---\n\nYou cut releases carefully.\n",
  "plugins/release/.mcp.json": JSON.stringify({ mcpServers: { tracker: { type: "http", url: "https://mcp.example.com/mcp" }, local: { command: "npx", args: ["server"] }, keyed: { type: "http", url: "https://keyed.example.com/mcp", headers: { "X-Key": "${ACME_KEY}" } } } }),
  "plugins/release/hooks/hooks.json": JSON.stringify({ hooks: {} }),
  "skills/brief/SKILL.md": "---\nname: brief\ndescription: Use when asked for a brief.\n---\n\nWrite a one-page brief.\n",
};

function githubFetch(repo = "acme/tools", files = REPO): Fetch {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === "raw.githubusercontent.com") {
      const [, owner, name, ref, ...rest] = u.pathname.split("/");
      const path = rest.map(decodeURIComponent).join("/");
      if (`${owner}/${name}` !== repo || (ref !== SHA && ref !== "HEAD" && ref !== "main")) return new Response("no", { status: 404 });
      const file = files[path];
      return file === undefined ? new Response("no", { status: 404 }) : new Response(file, { status: 200 });
    }
    if (u.hostname === "api.github.com") {
      if (u.pathname === `/repos/${repo}/commits/HEAD` || u.pathname === `/repos/${repo}/commits/main`) return Response.json({ sha: SHA });
      if (u.pathname === `/repos/${repo}/git/trees/${SHA}`) return Response.json({ tree: Object.entries(files).map(([path, content]) => ({ path, type: "blob", size: content.length })), truncated: false });
      return new Response("no", { status: 404 });
    }
    return new Response("no", { status: 404 });
  };
}

const ws = "wsp_acme";
const at = new Date("2026-10-11T12:00:00.000Z");
const deps = { fetchFn: githubFetch() };

test("a marketplace is read from GitHub by its address, its plugins listed with where each would be fetched from", async () => {
  const read = await fetchMarketplace({ source: "github", repo: "acme/tools" }, deps);
  assert.ok(read.ok);
  assert.equal(read.sha, SHA);
  const manifest = parseMarketplaceManifest(read.json);
  assert.ok(manifest.ok);
  const db = fakeD1();
  const added = await marketplaces.addMarketplace(db, ws, null, { source: "github", repo: "acme/tools" }, "chase", deps, "g1t.sh", at);
  assert.ok(added.ok);
  assert.deepEqual({ name: added.value.name, owner: added.value.owner, plugins: added.value.plugins, builtin: added.value.builtin, can_remove: added.value.can_remove }, { name: "acme-tools", owner: "Acme", plugins: 3, builtin: false, can_remove: true });
  const again = await marketplaces.addMarketplace(db, ws, null, { source: "github", repo: "acme/tools" }, "chase", deps, "g1t.sh", at);
  assert.equal(!again.ok && again.error.code, "conflict");
  const reserved = await marketplaces.addMarketplace(db, ws, "claude-plugins-official", { source: "github", repo: "acme/tools" }, "chase", deps, "g1t.sh", at);
  assert.equal(!reserved.ok && reserved.error.code, "invalid");
  // The built-ins can't be read in this test (no GitHub), so they are listed with a problem and no plugins; the workspace's own lists three.
  const all = await marketplaces.loadAll(db, ws, deps, "g1t.sh", at);
  const listings = marketplaces.discoverPlugins(all, new Map(), "g1t.sh");
  // The workspace's own marketplace first; g1t's announced plugins after it.
  assert.deepEqual(
    listings.filter((l) => l.marketplace === "acme-tools").map((l) => [l.ref, l.availability.kind, l.fetch.kind]),
    [
      ["release@acme-tools", "available", "github"],
      ["docs-skills@acme-tools", "available", "github"],
      ["from-npm@acme-tools", "unavailable", "unsupported"],
    ],
  );
  assert.ok(listings.some((l) => l.ref === "mail@g1t" && l.availability.kind === "soon"));
  assert.deepEqual(listings[0]!.fetch, { kind: "github", repo: "acme/tools", ref: null, sha: null, path: "plugins/release" });
  const skills = marketplaces.discoverSkills(listings, new Set());
  assert.deepEqual(
    skills.map((s) => [s.ref, s.plugin, s.added]),
    [["docs-skills:brief", "docs-skills", false]],
  );
  const out = marketplaces.marketplacesOut(all, true);
  assert.deepEqual(
    out.map((m) => [m.name, m.builtin, m.can_remove]),
    [
      ["claude-plugins-official", true, false],
      ["anthropic-agent-skills", true, false],
      ["acme-tools", false, true],
      ["g1t", true, false],
    ],
  );
  const removed = await marketplaces.removeMarketplace(db, ws, "acme-tools");
  assert.ok(removed.ok);
  assert.equal(!(await marketplaces.removeMarketplace(db, ws, "claude-plugins-official")).ok, true);
});

test("a plugin is fetched from GitHub at a commit, read, and installed: skills into the library under its name, agents kept, servers found", async () => {
  const plan = { kind: "github" as const, repo: "acme/tools", ref: null, sha: null, path: "plugins/release" };
  const fetched = await fetchPlugin(plan, deps);
  assert.ok(fetched.ok);
  assert.equal(fetched.sha, SHA);
  assert.deepEqual(fetched.files.map((f) => f.path).sort(), [".claude-plugin/plugin.json", ".mcp.json", "README.md", "agents/releaser.md", "commands/cut.md", "hooks/hooks.json", "skills/code/SKILL.md", "skills/release-notes/SKILL.md", "skills/release-notes/references/template.md"]);
  const read = plugins.readPlugin(fetched.files, fetched.sha, null);
  assert.equal(read.manifest?.version, "1.2.0");
  assert.deepEqual(
    read.components.skills.map((s) => [s.name, s.description]),
    [
      ["code", "A plugin skill with a foundational name."],
      ["release-notes", "Use when asked for release notes."],
    ],
  );
  assert.deepEqual(read.components.commands.map((c) => c.name), ["cut"]);
  assert.deepEqual(read.agents.map((a) => [a.name, a.model, a.tools]), [["releaser", "sonnet", ["Read", "Bash"]]]);
  assert.deepEqual(
    read.components.mcp_servers.map((s) => [s.name, s.type, s.remote]),
    [
      ["tracker", "http", true],
      ["local", "stdio", false],
      ["keyed", "http", true],
    ],
  );
  assert.equal(read.components.hooks, true);
  assert.equal(read.readme, "# Release\n\nCuts releases.");

  const db = fakeD1();
  await marketplaces.addMarketplace(db, ws, null, { source: "github", repo: "acme/tools" }, "chase", deps, "g1t.sh", at);
  const all = await marketplaces.loadAll(db, ws, deps, "g1t.sh", at);
  const listings = marketplaces.discoverPlugins(all, new Map(), "g1t.sh");
  const listing = marketplaces.findListing(listings, "release@acme-tools")!;
  const entry = marketplaces.entryOf(all, { name: "release", marketplace: "acme-tools" })!;
  const done = await plugins.install(db, { workspaceId: ws, listing, entry: entry.entry, marketplace: { name: "acme-tools", source: entry.source, pluginRoot: entry.pluginRoot }, host: "g1t.sh", by: "chase", deps, now: at });
  assert.ok(done.ok);
  assert.deepEqual(done.value.skills.map((s) => [s.name, s.problem]), [
    ["code", null],
    ["release-notes", null],
    ["cut", null],
  ]);
  assert.equal(done.value.install.sha, SHA);
  assert.deepEqual(done.value.install.fetch, { ...plan, sha: SHA });
  // The library has them, named by the plugin, read-only, with Claude Code's tools kept aside.
  const notes = await skillByName(db, ws, "release-notes", "release@acme-tools");
  assert.ok(notes);
  assert.equal(notes.plugin, "release@acme-tools");
  assert.equal(await skillByName(db, ws, "release-notes"), null);
  const code = await skillByName(db, ws, "code", "release@acme-tools");
  assert.ok(code, "a plugin skill may carry a foundational name");
  const version = await db.prepare("SELECT skill_md FROM skill_versions WHERE skill_id = ? AND version = 1").bind(notes.id).first<{ skill_md: string }>();
  assert.match(version!.skill_md, /allowed-tools: Read, Bash/);
  // Attached to every agent, it reaches an agent as `release:release-notes`.
  await db.prepare("INSERT INTO skill_attachments (id, workspace_id, skill_id, scope, target, version, attached_by, attached_at) VALUES ('ska_1', ?, ?, 'workspace', '', 1, 'chase', ?)").bind(ws, notes.id, at.toISOString()).run();
  const rows = await attachedRows(db, ws, "agt_1", []);
  const shelf = shelfFrom([], rows).skills.filter((s) => s.kind === "library");
  assert.deepEqual(shelf.map((s) => s.name), ["release:release-notes"]);
  // Installed twice is a conflict; its agents are templates; Discover marks it installed.
  const twice = await plugins.install(db, { workspaceId: ws, listing: { ...listing, availability: { kind: "installed", enabled: true } }, entry: entry.entry, marketplace: { name: "acme-tools", source: entry.source, pluginRoot: entry.pluginRoot }, host: "g1t.sh", by: "chase", deps, now: at });
  assert.equal(!twice.ok && twice.error.code, "conflict");
  assert.deepEqual((await plugins.pluginAgents(db, ws)).map((a) => [a.ref, a.model]), [["release:releaser", "sonnet"]]);
  const marked = marketplaces.discoverPlugins(all, new Map([["release@acme-tools", { enabled: true }]]), "g1t.sh");
  assert.deepEqual(marked[0]!.availability, { kind: "installed", enabled: true });
  // Switched off, its skills leave prompts; uninstalled, they are archived and detached.
  const off = await plugins.setEnabled(db, ws, "release@acme-tools", false, at);
  assert.ok(off.ok && !off.value.enabled);
  assert.deepEqual(await attachedRows(db, ws, "agt_1", []), []);
  assert.deepEqual((await plugins.pluginAgents(db, ws)).length, 0);
  await plugins.setEnabled(db, ws, "release@acme-tools", true, at);
  assert.equal((await attachedRows(db, ws, "agt_1", [])).length, 1);
  const gone = await plugins.uninstall(db, ws, "release@acme-tools", "chase", at);
  assert.ok(gone.ok);
  assert.deepEqual(gone.value.skills.sort(), ["code", "cut", "release-notes"]);
  assert.equal(await skillByName(db, ws, "release-notes", "release@acme-tools"), null);
  assert.deepEqual(await attachedRows(db, ws, "agt_1", []), []);
  assert.deepEqual(await plugins.listInstalls(db, ws), []);
});

test("a skills-only plugin at a marketplace's root installs the skills its entry names", async () => {
  const db = fakeD1();
  await marketplaces.addMarketplace(db, ws, null, { source: "github", repo: "acme/tools" }, "chase", deps, "g1t.sh", at);
  const all = await marketplaces.loadAll(db, ws, deps, "g1t.sh", at);
  const listings = marketplaces.discoverPlugins(all, new Map(), "g1t.sh");
  const listing = marketplaces.findListing(listings, "docs-skills@acme-tools")!;
  const entry = marketplaces.entryOf(all, { name: "docs-skills", marketplace: "acme-tools" })!;
  const done = await plugins.install(db, { workspaceId: ws, listing, entry: entry.entry, marketplace: { name: "acme-tools", source: entry.source, pluginRoot: entry.pluginRoot }, host: "g1t.sh", by: "chase", deps, now: at });
  assert.ok(done.ok);
  assert.deepEqual(done.value.skills.map((s) => s.name), ["brief"]);
  // Not the marketplace's other plugins' skills, though they are in the same repository.
  assert.equal(await skillByName(db, ws, "release-notes", "docs-skills@acme-tools"), null);
  const skills = marketplaces.discoverSkills(listings, new Set(["docs-skills@acme-tools/brief"]));
  assert.equal(skills[0]!.added, true);
});

test("what can't be fetched says why, and a marketplace that moved on shows an update", async () => {
  const npm = await fetchPlugin({ kind: "unsupported", why: "It is published on npm." }, deps);
  assert.equal(!npm.ok && npm.message, "It is published on npm.");
  const missing = await fetchPlugin({ kind: "github", repo: "acme/tools", ref: null, sha: null, path: "plugins/nothing" }, deps);
  assert.equal(!missing.ok && missing.message, "There are no files in plugins/nothing of acme/tools.");
  const gone = await fetchMarketplace({ source: "github", repo: "acme/gone" }, deps);
  assert.match(!gone.ok ? gone.message : "", /no \.claude-plugin\/marketplace\.json/);
  const row: plugins.PluginRow = { id: "plg_1", workspace_id: ws, ref: "release@acme-tools", name: "release", marketplace: "acme-tools", display_name: null, description: "", version: "1.0.0", sha: "a".repeat(40), fetch: JSON.stringify({ kind: "github", repo: "acme/tools", ref: null, sha: "a".repeat(40), path: "plugins/release" }), components: "{}", agents: "[]", problems: "[]", enabled: 1, installed_by: "chase", installed_at: at.toISOString(), updated_at: at.toISOString(), uninstalled_by: null, uninstalled_at: null };
  const listing = { ref: "release@acme-tools", name: "release", marketplace: "acme-tools", display_name: null, description: "", version: "1.2.0", author: null, homepage: null, category: null, tags: [], keywords: [], fetch: { kind: "github" as const, repo: "acme/tools", ref: null, sha: null, path: "plugins/release" }, availability: { kind: "available" as const }, skills: [] };
  assert.deepEqual(plugins.installsOut([row], [listing])[0]!.update, { version: "1.2.0", sha: null });
  assert.equal(plugins.installsOut([row], [{ ...listing, version: "1.0.0" }])[0]!.update, null);
});

test("a plugin skill larger than a version holds keeps its text and leaves its biggest binaries out", () => {
  const big = "A".repeat(1_200_000);
  const files = [
    { path: "SKILL.md", content: "---\nname: canvas\ndescription: Use when drawing.\n---\n\nDraw.\n", encoding: "utf8" as const },
    { path: "reference.md", content: "# Reference\n", encoding: "utf8" as const },
    { path: "fonts/a.ttf", content: big, encoding: "base64" as const },
    { path: "fonts/b.ttf", content: big, encoding: "base64" as const },
    { path: "scripts/draw.py", content: "print(1)\n", encoding: "utf8" as const },
  ];
  const fitted = plugins.fitSkillFolder(files);
  assert.deepEqual(fitted.omitted, ["fonts/a.ttf"], "one font out brings it under the limit; text stays");
  assert.deepEqual(fitted.files.map((f) => f.path).sort(), ["SKILL.md", "fonts/b.ttf", "reference.md", "scripts/draw.py"]);
  assert.deepEqual(plugins.fitSkillFolder(files.slice(0, 2)).omitted, []);
});

test("an installed plugin updates in place at its marketplace's newer commit: skill versions move with their attachments, gone skills are archived; unchanged when at the same commit", async () => {
  const db = fakeD1();
  await marketplaces.addMarketplace(db, ws, null, { source: "github", repo: "acme/tools" }, "chase", deps, "g1t.sh", at);
  const all = await marketplaces.loadAll(db, ws, deps, "g1t.sh", at);
  const listings = marketplaces.discoverPlugins(all, new Map(), "g1t.sh");
  const listing = marketplaces.findListing(listings, "release@acme-tools")!;
  const entry = marketplaces.entryOf(all, { name: "release", marketplace: "acme-tools" })!;
  const input = { workspaceId: ws, listing, entry: entry.entry, marketplace: { name: "acme-tools", source: entry.source, pluginRoot: entry.pluginRoot }, host: "g1t.sh", by: "chase", deps, now: at };
  const installed = await plugins.install(db, input);
  assert.ok(installed.ok);
  const notes = (await skillByName(db, ws, "release-notes", "release@acme-tools"))!;
  await db.prepare("INSERT INTO skill_attachments (id, workspace_id, skill_id, scope, target, version, attached_by, attached_at) VALUES ('ska_1', ?, ?, 'workspace', '', 1, 'chase', ?)").bind(ws, notes.id, at.toISOString()).run();
  // Same commit: nothing moves.
  const same = await plugins.update(db, input);
  assert.ok(same.ok && same.value.unchanged);
  // The repository moves on: a new version, a changed skill, the "code" skill gone.
  const NEXT = "fedcba9876543210fedcba9876543210fedcba98";
  const files = { ...REPO };
  delete files["plugins/release/skills/code/SKILL.md"];
  files["plugins/release/.claude-plugin/plugin.json"] = JSON.stringify({ name: "release", version: "1.3.0", description: "Cuts releases, now with notes" });
  files["plugins/release/skills/release-notes/SKILL.md"] = "---\nname: release-notes\ndescription: Use when asked for release notes or a changelog.\n---\n\nRead the merged pull requests, group them, write the notes, link each.\n";
  const moved: Fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "api.github.com" && (u.pathname.endsWith("/commits/HEAD") || u.pathname.endsWith("/commits/main"))) return Response.json({ sha: NEXT });
    if (u.hostname === "api.github.com" && u.pathname === `/repos/acme/tools/git/trees/${NEXT}`) return Response.json({ tree: Object.entries(files).map(([path, content]) => ({ path, type: "blob", size: content.length })), truncated: false });
    if (u.hostname === "raw.githubusercontent.com") {
      const [, , , ref, ...rest] = u.pathname.split("/");
      const file = files[rest.map(decodeURIComponent).join("/")];
      return ref === NEXT && file !== undefined ? new Response(file) : new Response("no", { status: 404 });
    }
    return githubFetch()(url, init);
  };
  const updated = await plugins.update(db, { ...input, deps: { fetchFn: moved }, now: new Date(at.getTime() + 60_000) });
  assert.ok(updated.ok, !updated.ok ? updated.error.message : "");
  assert.equal(updated.value.unchanged, false);
  assert.equal(updated.value.install.version, "1.3.0");
  assert.equal(updated.value.install.sha, NEXT);
  assert.equal(updated.value.install.description, "Cuts releases, now with notes");
  const after = (await skillByName(db, ws, "release-notes", "release@acme-tools"))!;
  assert.equal(after.version, 2);
  assert.equal((await db.prepare("SELECT version FROM skill_attachments WHERE id = 'ska_1'").first<{ version: number }>())!.version, 2, "the attachment followed");
  assert.equal(await skillByName(db, ws, "code", "release@acme-tools"), null, "a skill the plugin no longer has is archived");
  assert.deepEqual(plugins.installsOut([(await plugins.installByRef(db, ws, "release@acme-tools"))!], [listing])[0]!.update, { version: "1.2.0", sha: null }, "the marketplace's cached listing still says 1.2.0 until it is read again");
});

test("g1t's own announced plugins are listed, as Soon, and can't be installed yet", async () => {
  const db = fakeD1();
  const all = await marketplaces.loadAll(db, ws, deps, "g1t.sh", at);
  const listings = marketplaces.discoverPlugins(all, new Map(), "g1t.sh");
  const own = listings.filter((l) => l.marketplace === "g1t");
  assert.ok(own.length >= 5);
  assert.ok(own.every((l) => l.availability.kind === "soon"));
  const mail = marketplaces.findListing(listings, "mail@g1t")!;
  assert.equal(mail.display_name, "Mail");
  const entry = marketplaces.entryOf(all, { name: "mail", marketplace: "g1t" })!;
  const refused = await plugins.install(db, { workspaceId: ws, listing: mail, entry: entry.entry, marketplace: { name: "g1t", source: entry.source, pluginRoot: null }, host: "g1t.sh", by: "chase", deps, now: at });
  assert.equal(!refused.ok && refused.error.code, "invalid");
});
