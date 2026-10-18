// node --test scripts/plugins-release.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { INSTALL, PUBLISHED, SOURCE, authEnv, tagName, build, expectedFiles, manifests, minimumCli, publish, scan, walk } from "./plugins-release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temps = [];
const temp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A copy of what the build reads from this repository, to change freely. */
function source() {
  const root = temp("plugins-src-");
  for (const path of [".claude-plugin", SOURCE, "plugins/codex", "LICENSE"]) cpSync(join(ROOT, path), join(root, path), { recursive: true });
  return root;
}
const editJson = (root, file, fn) => {
  const path = join(root, file);
  writeFileSync(path, JSON.stringify(fn(JSON.parse(readFileSync(path, "utf8"))), null, 2));
};
const bump = (root, version) => {
  editJson(root, ".claude-plugin/marketplace.json", (m) => ({ ...m, plugins: [{ ...m.plugins[0], version }] }));
  editJson(root, `${SOURCE}/.claude-plugin/plugin.json`, (p) => ({ ...p, version }));
};
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

test("this repository's manifests agree: g1t@g1t, one version", () => {
  const { marketplace, plugin, version } = manifests();
  assert.equal(marketplace.plugins[0].version, version);
  assert.equal(plugin.version, version);
});

test("the build is the marketplace, the plugin without its tests, a README and the license", () => {
  const out = join(temp("plugins-out-"), "tree");
  const { version } = build(out);
  const files = walk(out);
  assert.deepEqual(files, expectedFiles());
  assert.ok(files.includes(`${PUBLISHED}/hooks/g1t.mjs`));
  assert.ok(!files.some((f) => f.includes("test/") || f.endsWith(".test.mjs")), files.join(" "));
  const marketplace = JSON.parse(readFileSync(join(out, ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "g1t");
  assert.deepEqual(marketplace.plugins.map((p) => [p.name, p.source, p.version]), [["g1t", "./plugins/g1t", version]]);
  // The plugin's files are the source's, byte for byte.
  for (const f of files.filter((f) => f.startsWith(`${PUBLISHED}/`))) {
    assert.equal(readFileSync(join(out, f), "utf8"), readFileSync(join(ROOT, SOURCE, f.slice(PUBLISHED.length + 1)), "utf8"), f);
  }
  const readme = readFileSync(join(out, "README.md"), "utf8");
  for (const line of INSTALL) assert.ok(readme.includes(line), line);
  // The CLI the README asks for is the one the hooks need.
  const hooks = readFileSync(join(ROOT, SOURCE, "hooks/g1t.mjs"), "utf8");
  assert.equal(minimumCli(), hooks.match(/export const MIN_CLI = "([^"]+)"/)?.[1]);
  assert.ok(readme.includes(`${minimumCli()} or later and Node`), readme);
});

test("manifests that disagree stop the build", () => {
  const root = source();
  editJson(root, ".claude-plugin/marketplace.json", (m) => ({ ...m, plugins: [{ ...m.plugins[0], version: "9.9.9" }] }));
  assert.throws(() => build(join(root, "out"), root), /marketplace.json says version 9.9.9/);
  const renamed = source();
  editJson(renamed, ".claude-plugin/marketplace.json", (m) => ({ ...m, name: "g1t-plugins" }));
  assert.throws(() => build(join(renamed, "out"), renamed), /installs are g1t@g1t/);
});

test("a file the script does not know about stops the build", () => {
  const root = source();
  writeFileSync(join(root, SOURCE, "notes.md"), "draft");
  assert.throws(() => build(join(root, "out"), root), /has notes\.md, which .* neither publishes nor keeps back/);
});

test("anything that looks like a credential, or a credentials file, is never published", () => {
  const root = source();
  writeFileSync(join(root, SOURCE, "commands", "status.md"), `token: g1t_${"a1".repeat(20)}\n`);
  assert.throws(() => build(join(root, "out"), root), /commands\/status\.md: looks like a g1t token/);
  const dir = temp("plugins-scan-");
  writeFileSync(join(dir, ".env"), "X=1");
  writeFileSync(join(dir, "k.md"), "-----BEGIN OPENSSH PRIVATE KEY-----");
  assert.deepEqual(scan(dir), [".env: a file that is never published", "k.md: looks like a private key"]);
  // The plugin as it is holds none.
  assert.deepEqual(scan(join(ROOT, SOURCE, "hooks")), []);
});

test("releases are tagged as claude plugin tag tags them", () => {
  assert.equal(tagName("0.2.2"), "g1t--v0.2.2");
});

test("the token goes to git through its environment, never its arguments", () => {
  const env = authEnv("g1t_secret");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.extraHeader");
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("g1t:g1t_secret").toString("base64")}`);
  assert.deepEqual(authEnv(undefined), {});
});

test("publishing: the first commit and tag, nothing when unchanged, a new version for a changed plugin", () => {
  const root = source();
  const remote = join(temp("plugins-remote-"), "g1t-plugins.git");
  git(dirname(remote), "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const run = (sourceCommit) => publish({ remote, token: "", source: sourceCommit, root, work: temp("plugins-work-") });
  const { version } = manifests(root);

  const first = run("a".repeat(40));
  assert.equal(first.changed, true);
  assert.equal(first.tagged, true);
  assert.equal(git(remote, "rev-parse", "main").stdout.trim(), first.commit);
  assert.equal(git(remote, "rev-parse", `g1t--v${version}^{commit}`).stdout.trim(), first.commit);
  assert.match(git(remote, "log", "-1", "--format=%an <%ae>%n%B", "main").stdout, /^g1t <g1t@users\.noreply\.g1t\.sh>\ng1t .*, from flagon-io\/g1t@aaaaaaaaaaaa/);
  const listed = git(remote, "ls-tree", "-r", "--name-only", "main").stdout.trim().split("\n").sort();
  assert.deepEqual(listed, expectedFiles(root));

  const again = run("b".repeat(40));
  assert.deepEqual([again.changed, again.tagged, again.commit], [false, false, first.commit]);

  // The plugin changed with its version already out: refused.
  writeFileSync(join(root, SOURCE, "commands", "status.md"), "changed\n");
  assert.throws(() => run("c".repeat(40)), /already published.*Bump "version"/s);
  assert.equal(git(remote, "rev-parse", "main").stdout.trim(), first.commit);

  bump(root, "99.0.0");
  const next = run("d".repeat(40));
  assert.equal(next.changed, true);
  assert.equal(next.tagged, true);
  assert.equal(git(remote, "rev-parse", "g1t--v99.0.0^{commit}").stdout.trim(), next.commit);
  assert.equal(git(remote, "rev-parse", `g1t--v${version}^{commit}`).stdout.trim(), first.commit);
  assert.equal(git(remote, "rev-parse", "main~1").stdout.trim(), first.commit);

  // Codex releases have their own version gate; a Claude bump is not enough.
  writeFileSync(join(root, "plugins/codex/skills/work-on-g1t/SKILL.md"), "changed Codex skill\n");
  assert.throws(() => run("f".repeat(40)), /Codex plugin files changed without a version bump/);
  editJson(root, "plugins/codex/plugin.json", p => ({ ...p, version: "0.1.1" }));
  assert.equal(run("1".repeat(40)).changed, true);

  // The marketplace's own text may change without a new version.
  editJson(root, ".claude-plugin/marketplace.json", (m) => ({ ...m, description: "g1t's plugins for Claude Code, and more." }));
  const text = run("e".repeat(40));
  assert.deepEqual([text.changed, text.tagged], [true, false]);
});

test("Codex catalog resolves its packaged skill and OAuth MCP server", () => {
  const out = join(temp("plugins-codex-"), "tree");
  build(out);
  const catalog = JSON.parse(readFileSync(join(out, ".agents/plugins/marketplace.json"), "utf8"));
  const entry = catalog.plugins[0];
  assert.equal(entry.source.source, "local");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  const plugin = join(out, entry.source.path);
  assert.equal(JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8")).name, entry.name);
  const mcp = JSON.parse(readFileSync(join(plugin, "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.g1t.type, "streamable-http");
  assert.equal(mcp.mcpServers.g1t.extensions["com.openai"].auth.client.mode, "dcr");
  assert.match(readFileSync(join(plugin, "skills/work-on-g1t/SKILL.md"), "utf8"), /harness: codex/);
});
