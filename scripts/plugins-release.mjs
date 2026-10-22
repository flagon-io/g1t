#!/usr/bin/env node
// Publishes g1t's Claude Code and Codex plugin marketplace to its own repository,
// flagon-io/g1t-plugins on g1t.sh, so adding the marketplace clones a few
// files rather than this monorepo:
//
//   claude plugin marketplace add https://g1t.sh/flagon-io/g1t-plugins.git
//   claude plugin install g1t@g1t
//
// This repository stays the source: .claude-plugin/marketplace.json and
// plugins/claude-code/ are where the plugin is changed and tested, and
// .g1t/workflows/plugins-release.yml runs this on every push to main that
// touches them. Nobody commits to g1t-plugins by hand.
//
//   node scripts/plugins-release.mjs check            # the manifests agree; nothing is written
//   node scripts/plugins-release.mjs build [DIR]      # the published tree (default target/g1t-plugins)
//   node scripts/plugins-release.mjs publish [--dry-run]
//
// What is published, and nothing else:
//
//   .claude-plugin/marketplace.json   this repository's, its plugin's source rewritten to ./plugins/g1t
//   plugins/g1t/                      plugins/claude-code/ without its tests (PLUGIN_FILES)
//   README.md                         written here (readme())
//   .agents/plugins/marketplace.json  Codex catalog, generated below
//   plugins/g1t-codex/                plugins/codex/, with its own version
//   LICENSE                           this repository's
//
// A file added to plugins/claude-code/ that PLUGIN_FILES does not name
// stops the build, so nothing is published or left out without a change
// here. Every published file is scanned for anything that looks like a
// credential.
//
// `publish` clones g1t-plugins, replaces its tree with the build, and
// commits on main only when something changed, naming this repository's
// commit; then tags g1t--v<version> once, the tag Claude Code's own
// `claude plugin tag` makes. Claude Code updates an installed
// plugin when its version changes, so a change to the plugin's files with
// the version already published stops the run: bump the version in
// plugins/claude-code/.claude-plugin/plugin.json and in marketplace.json.
//
//   G1T_PLUGINS_REMOTE        where to publish (default https://g1t.sh/flagon-io/g1t-plugins.git)
//   PLUGINS_PUBLISH_TOKEN     a g1t access token that can push there; sent as a
//                             git header through the environment, never on a
//                             command line
//   G1T_SOURCE_COMMIT         this repository's commit, for the commit message
//                             (default: git rev-parse HEAD)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = "plugins/claude-code";
export const CODEX_SOURCE = "plugins/codex";
export const CODEX_PUBLISHED = "plugins/g1t-codex";
export const CODEX_FILES = ["plugin.json", "mcp.json", "skills", "hooks"];
// The Codex plugin's hooks run the Claude Code plugin's g1t.mjs, one core
// for both harnesses: the build copies it in beside hooks/hooks.json.
export const CODEX_HOOK = "hooks/g1t.mjs";
export const CODEX_INSTALL = "codex plugin marketplace add https://g1t.sh/flagon-io/g1t-plugins.git";
export const PUBLISHED = "plugins/g1t";
export const REMOTE = "https://g1t.sh/flagon-io/g1t-plugins.git";
export const INSTALL = ["claude plugin marketplace add https://g1t.sh/flagon-io/g1t-plugins.git", "claude plugin install g1t@g1t"];

// What of plugins/claude-code/ is the plugin: entries published whole.
// DEV_FILES are this repository's only (the hooks' tests and their stand-in
// CLI). Anything else in the folder stops the build.
export const PLUGIN_FILES = [".claude-plugin", ".mcp.json", "commands", "hooks", "skills"];
export const DEV_FILES = ["test"];

// Names no published file may have, and text no published file may hold.
const FORBIDDEN_NAMES = [/^\.env/, /^\.credentials/, /\.(pem|key|p12|pfx)$/i, /^id_(rsa|ed25519|ecdsa)/, /^\.npmrc$/, /^node_modules$/];
const SECRETS = [
  ["a g1t token", /\bg1t[a-z]*_[0-9a-f]{32,}/],
  ["an Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI key", /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ["a GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["an AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["a Stripe key", /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const readJson = (root, file) => JSON.parse(readFileSync(join(root, file), "utf8"));

/** Every file under `dir` but git's own, as paths relative to it with forward slashes, sorted. */
export function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, base));
    else out.push(relative(base, path).replaceAll("\\", "/"));
  }
  return out.sort();
}

/**
 * The marketplace and plugin manifests, checked against each other: one
 * plugin, g1t, in a marketplace g1t (so it installs as g1t@g1t wherever it
 * is published from), whose source is plugins/claude-code and whose version
 * is the plugin's own. Returns them, and the version.
 */
export function manifests(root = ROOT) {
  const marketplace = readJson(root, ".claude-plugin/marketplace.json");
  const plugin = readJson(root, `${SOURCE}/.claude-plugin/plugin.json`);
  const problems = [];
  if (marketplace.name !== "g1t") problems.push(`the marketplace is named ${JSON.stringify(marketplace.name)}, not "g1t": installs are g1t@g1t`);
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) problems.push("the marketplace lists one plugin, g1t");
  const entry = marketplace.plugins?.[0] ?? {};
  if (entry.name !== "g1t" || plugin.name !== "g1t")
    problems.push(`the plugin is named ${JSON.stringify(entry.name)} in marketplace.json and ${JSON.stringify(plugin.name)} in plugin.json, not "g1t"`);
  if (entry.source !== `./${SOURCE}`) problems.push(`marketplace.json's source is ${JSON.stringify(entry.source)}, not "./${SOURCE}"`);
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? "")) problems.push(`plugin.json's version ${JSON.stringify(plugin.version)} is not x.y.z`);
  if (entry.version !== plugin.version) problems.push(`marketplace.json says version ${entry.version} and plugin.json ${plugin.version}: make them the same`);
  if (entry.description !== plugin.description) problems.push("marketplace.json's description is not plugin.json's");
  if (problems.length) throw new Error(`The plugin's manifests disagree:\n- ${problems.join("\n- ")}`);
  return { marketplace, plugin, version: plugin.version };
}

/** The marketplace manifest as published: its plugin's source is ./plugins/g1t. */
export function publishedMarketplace(marketplace) {
  return { ...marketplace, plugins: marketplace.plugins.map((p) => ({ ...p, source: `./${PUBLISHED}` })) };
}

/**
 * The oldest g1t CLI the plugin's hooks work with: the CLI contract's
 * minimum_version, which the hooks' MIN_CLI keeps to.
 */
export function minimumCli(root = ROOT) {
  return readJson(root, `${SOURCE}/test/cli-contract.json`).minimum_version;
}

export function readme(version, cli = minimumCli()) {
  return `# g1t plugins

g1t's plugin marketplace for Claude Code and Codex. Choose your client below.

## Claude Code

The Claude Code plugin, \`g1t\` (${version}),
records your Claude Code sessions on g1t, gives Claude the work item it is
working on, claims and hands off work, and adds g1t's MCP server, skills
and commands.

\`\`\`sh
${INSTALL.join("\n")}
\`\`\`

Then start Claude Code again, run \`/mcp\` and sign **plugin:g1t:g1t** in.
The plugin's hooks need the [g1t CLI](https://docs.g1t.sh/guides/cli/)
${cli} or later and Node 18 or later.

To keep the plugin current, run \`/plugin\`, open **Marketplaces**, choose
**g1t** and **Enable auto-update**: Claude Code doesn't update this
marketplace by itself otherwise.

The guide, with what each hook records and never records and how to opt
out: https://docs.g1t.sh/guides/claude-code-plugin/

This repository is published automatically from
[flagon-io/g1t](https://g1t.sh/flagon-io/g1t) (\`.claude-plugin/\` and
\`${SOURCE}/\`). Changes and issues go there.
`;
}

/** Codex's catalog uses paths relative to the marketplace root. */
export function codexMarketplace() {
  return {
    name: "g1t",
    interface: { displayName: "g1t" },
    plugins: [
      {
        name: "g1t",
        source: { source: "local", path: `./${CODEX_PUBLISHED}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
    ],
  };
}

function codexManifest(root) {
  const plugin = readJson(root, `${CODEX_SOURCE}/plugin.json`);
  if (plugin.name !== "g1t" || !/^\d+\.\d+\.\d+$/.test(plugin.version ?? "")) throw new Error("Invalid Codex plugin identity or version");
  const extra = readdirSync(join(root, CODEX_SOURCE)).filter((name) => !CODEX_FILES.includes(name));
  if (extra.length) throw new Error(`Unlisted Codex plugin files: ${extra.join(", ")}`);
  return plugin;
}

/** A release's tag: `claude plugin tag`'s {name}--v{version}. */
export const tagName = (version) => `g1t--v${version}`;

/** Why the folder cannot be published as it is: entries PLUGIN_FILES and DEV_FILES do not name. */
function unlisted(root) {
  return readdirSync(join(root, SOURCE)).filter((name) => !PLUGIN_FILES.includes(name) && !DEV_FILES.includes(name));
}

/** Credentials and forbidden files in a built tree, as "path: what". */
export function scan(dir) {
  const found = [];
  for (const file of walk(dir)) {
    for (const part of file.split("/")) if (FORBIDDEN_NAMES.some((re) => re.test(part))) found.push(`${file}: a file that is never published`);
    const text = readFileSync(join(dir, file), "utf8");
    for (const [what, re] of SECRETS) if (re.test(text)) found.push(`${file}: looks like ${what}`);
  }
  return found;
}

/** The files the build writes, relative to its folder: the only ones it may contain. */
export function expectedFiles(root = ROOT) {
  const plugin = PLUGIN_FILES.flatMap((name) => {
    const path = join(root, SOURCE, name);
    return statSync(path).isDirectory() ? walk(path).map((f) => `${PUBLISHED}/${name}/${f}`) : [`${PUBLISHED}/${name}`];
  });
  const codex = [...walk(join(root, CODEX_SOURCE)), CODEX_HOOK].map((f) => `${CODEX_PUBLISHED}/${f}`);
  return [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", "LICENSE", "README.md", ...plugin, ...new Set(codex)].sort();
}

/** Writes the published tree to `out`, replacing what was there, and checks it. */
export function build(out = join(ROOT, "target", "g1t-plugins"), root = ROOT) {
  const { marketplace, version } = manifests(root);
  codexManifest(root);
  const extra = unlisted(root);
  if (extra.length)
    throw new Error(
      `${SOURCE}/ has ${extra.join(", ")}, which scripts/plugins-release.mjs neither publishes nor keeps back: add each to PLUGIN_FILES or DEV_FILES.`,
    );
  for (const name of PLUGIN_FILES) if (!existsSync(join(root, SOURCE, name))) throw new Error(`${SOURCE}/${name} is missing`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, ".claude-plugin"), { recursive: true });
  writeFileSync(join(out, ".claude-plugin", "marketplace.json"), `${JSON.stringify(publishedMarketplace(marketplace), null, 2)}\n`);
  for (const name of PLUGIN_FILES) cpSync(join(root, SOURCE, name), join(out, PUBLISHED, name), { recursive: true });
  mkdirSync(join(out, ".agents/plugins"), { recursive: true });
  writeFileSync(join(out, ".agents/plugins/marketplace.json"), JSON.stringify(codexMarketplace(), null, 2) + "\n");
  for (const name of CODEX_FILES) cpSync(join(root, CODEX_SOURCE, name), join(out, CODEX_PUBLISHED, name), { recursive: true });
  cpSync(join(root, SOURCE, "hooks", "g1t.mjs"), join(out, CODEX_PUBLISHED, CODEX_HOOK));
  writeFileSync(
    join(out, "README.md"),
    readme(version, minimumCli(root)) +
      `
## Codex

Add this marketplace with:

\`\`\`sh
${CODEX_INSTALL}
codex plugin add g1t@g1t
\`\`\`

In the ChatGPT desktop app's Plugins directory, choose the g1t marketplace,
install g1t and authorize its MCP connection. Restart the app if needed.
The Codex plugin (${codexManifest(root).version}) bundles the remote MCP server, a
work item/session workflow skill, and hooks that record each Codex session on
g1t with what it cost, through the g1t CLI. Codex asks you to review and trust
its hooks (\`/hooks\`) before they run. Disable a duplicate standalone g1t MCP
connection if installed.
Direct MCP setup and ChatGPT instructions: https://docs.g1t.sh/guides/bring-your-own-agent/
`,
  );
  cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
  verify(out, root);
  return { out, version };
}

/** Checks a built tree: exactly the expected files, manifests that agree, nothing secret. */
export function verify(dir, root = ROOT) {
  const { version } = manifests(root);
  const problems = [];
  const files = walk(dir);
  const expected = expectedFiles(root);
  const more = files.filter((f) => !expected.includes(f));
  const fewer = expected.filter((f) => !files.includes(f));
  if (more.length) problems.push(`files that are not the plugin's: ${more.join(", ")}`);
  if (fewer.length) problems.push(`missing: ${fewer.join(", ")}`);
  const marketplace = readJson(dir, ".claude-plugin/marketplace.json");
  const entry = marketplace.plugins?.[0] ?? {};
  if (entry.source !== `./${PUBLISHED}`) problems.push(`the published source is ${JSON.stringify(entry.source)}`);
  const plugin = readJson(dir, `${PUBLISHED}/.claude-plugin/plugin.json`);
  if (marketplace.name !== "g1t" || entry.name !== "g1t" || plugin.name !== "g1t") problems.push("the names are not g1t@g1t");
  if (entry.version !== version || plugin.version !== version)
    problems.push(`versions: marketplace ${entry.version}, plugin ${plugin.version}, source ${version}`);
  for (const file of [`${PUBLISHED}/.mcp.json`, `${PUBLISHED}/hooks/hooks.json`]) readJson(dir, file);
  const codex = readJson(dir, `${CODEX_PUBLISHED}/plugin.json`);
  if (codex.name !== "g1t" || codex.version !== codexManifest(root).version) problems.push("Codex plugin identity or version differs from source");
  if (JSON.stringify(readJson(dir, ".agents/plugins/marketplace.json")) !== JSON.stringify(codexMarketplace()))
    problems.push("Codex marketplace differs from expected catalog");
  const mcp = readJson(dir, `${CODEX_PUBLISHED}/mcp.json`);
  if (mcp.mcpServers?.g1t?.url !== "https://mcp.g1t.sh" || mcp.mcpServers?.g1t?.type !== "streamable-http") problems.push("Invalid Codex MCP server");
  readJson(dir, `${CODEX_PUBLISHED}/hooks/hooks.json`);
  if (readFileSync(join(dir, CODEX_PUBLISHED, CODEX_HOOK), "utf8") !== readFileSync(join(root, SOURCE, "hooks", "g1t.mjs"), "utf8"))
    problems.push("The Codex plugin's g1t.mjs differs from the Claude Code plugin's");
  problems.push(...scan(dir));
  if (problems.length) throw new Error(`The published tree is wrong:\n- ${problems.join("\n- ")}`);
}

function git(cwd, args, { env = {}, allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args[0]} failed (${r.status}): ${(r.stderr || r.stdout).trim()}`);
  return r;
}

/**
 * The token as a git header, through git's environment config
 * (GIT_CONFIG_COUNT), so it is on no command line and in no file.
 */
export function authEnv(token) {
  if (!token) return {};
  const basic = Buffer.from(`g1t:${token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

/**
 * Publishes the build to `remote`'s main and tags v<version>. Returns
 * { changed, commit, tagged }. An empty repository gets its first commit.
 */
export function publish({
  remote = process.env.G1T_PLUGINS_REMOTE || REMOTE,
  token = process.env.PLUGINS_PUBLISH_TOKEN,
  source,
  dryRun = false,
  root = ROOT,
  work,
} = {}) {
  source ??= process.env.G1T_SOURCE_COMMIT || git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const env = authEnv(token);
  work ??= mkdtempSync(join(tmpdir(), "g1t-plugins-"));
  const built = join(work, "build");
  const clone = join(work, "clone");
  const { version } = build(built, root);

  git(work, ["clone", "--quiet", remote, clone], { env });
  const hasMain = git(clone, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], { allowFail: true }).status === 0;
  if (hasMain) git(clone, ["checkout", "--quiet", "-B", "main", "origin/main"]);
  else git(clone, ["checkout", "--quiet", "--orphan", "main"]);

  const codexBefore = hasMain && existsSync(join(clone, CODEX_PUBLISHED, "plugin.json")) ? readJson(clone, `${CODEX_PUBLISHED}/plugin.json`).version : null;
  const before =
    hasMain && existsSync(join(clone, PUBLISHED, ".claude-plugin", "plugin.json")) ? readJson(clone, `${PUBLISHED}/.claude-plugin/plugin.json`).version : null;
  for (const name of readdirSync(clone)) if (name !== ".git") rmSync(join(clone, name), { recursive: true, force: true });
  cpSync(built, clone, { recursive: true });
  verify(clone, root);

  git(clone, ["add", "--all"]);
  const changed = git(clone, ["status", "--porcelain"]).stdout.trim() !== "";
  const pluginChanged = hasMain ? git(clone, ["diff", "--cached", "--quiet", "--", PUBLISHED], { allowFail: true }).status !== 0 : true;
  if (pluginChanged && before === version) {
    throw new Error(
      `The plugin's files changed, but ${version} is already published, and Claude Code updates installed plugins only when the version changes. Bump "version" in ${SOURCE}/.claude-plugin/plugin.json and .claude-plugin/marketplace.json.`,
    );
  }

  const codexChanged = hasMain ? git(clone, ["diff", "--cached", "--quiet", "--", CODEX_PUBLISHED], { allowFail: true }).status !== 0 : true;
  if (codexChanged && codexBefore === codexManifest(root).version)
    throw new Error("Codex plugin files changed without a version bump in plugins/codex/plugin.json");
  const tag = tagName(version);
  const remoteTag = git(clone, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { env }).stdout.trim();
  let commit = hasMain ? git(clone, ["rev-parse", "HEAD"]).stdout.trim() : null;
  if (changed) {
    const ident = ["-c", "user.name=g1t", "-c", "user.email=g1t@users.noreply.g1t.sh"];
    git(clone, [
      ...ident,
      "commit",
      "--quiet",
      "-m",
      `g1t ${version}, from flagon-io/g1t@${source.slice(0, 12)}\n\nPublished by scripts/plugins-release.mjs from https://g1t.sh/flagon-io/g1t/commit/${source}.\nChange the plugin there; this repository is overwritten.`,
    ]);
    commit = git(clone, ["rev-parse", "HEAD"]).stdout.trim();
  }
  const tagged = !remoteTag && commit != null;
  if (dryRun) return { changed, commit, tagged, version, dir: clone };
  if (changed) git(clone, ["push", "--quiet", "origin", "main:refs/heads/main"], { env });
  if (tagged) git(clone, ["push", "--quiet", "origin", `${commit}:refs/tags/${tag}`], { env });
  return { changed, commit, tagged, version, dir: clone };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/plugins-release.mjs")) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "check") {
      const { version } = manifests();
      const dir = mkdtempSync(join(tmpdir(), "g1t-plugins-check-"));
      build(dir);
      rmSync(dir, { recursive: true, force: true });
      console.log(`g1t@g1t ${version}: the manifests agree and the published tree is only the plugin`);
    } else if (command === "build") {
      const { out, version } = build(rest[0] ? join(process.cwd(), rest[0]) : undefined);
      console.log(
        `Built g1t@g1t ${version} in ${out}:\n${walk(out)
          .map((f) => `  ${f}`)
          .join("\n")}`,
      );
    } else if (command === "publish") {
      const dryRun = rest.includes("--dry-run");
      const r = publish({ dryRun });
      const where = process.env.G1T_PLUGINS_REMOTE || REMOTE;
      console.log(
        r.changed
          ? `${dryRun ? "Would publish" : "Published"} g1t ${r.version} to ${where} as ${r.commit}`
          : `${where} already has g1t ${r.version}; nothing to publish`,
      );
      if (r.tagged) console.log(`${dryRun ? "Would tag" : "Tagged"} ${tagName(r.version)}`);
      if (process.env.GITHUB_STEP_SUMMARY)
        writeFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `- g1t@g1t ${r.version}: ${r.changed ? `published as \`${r.commit}\`` : "unchanged"}${r.tagged ? `, tagged \`${tagName(r.version)}\`` : ""}\n`,
          { flag: "a" },
        );
    } else {
      console.error("usage: node scripts/plugins-release.mjs check | build [DIR] | publish [--dry-run]");
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
