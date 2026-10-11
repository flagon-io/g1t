import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILTIN_MARKETPLACES,
  fetchPlan,
  githubRepoOf,
  isReservedMarketplaceName,
  marketplaceNameProblem,
  namespaced,
  parseMarketplaceAddress,
  parseMarketplaceManifest,
  parseMcpServers,
  parsePluginManifest,
  parsePluginRef,
  parsePluginSource,
  pluginLayout,
  pluginNameProblem,
  pluginRef,
  subagentOf,
} from "./claude-plugin.ts";
import { parseFrontMatter, splitFrontMatter } from "./skill-format.ts";

/** A subagent file read the way the agents service reads one. */
function parseSubagentFile(text: string) {
  const split = splitFrontMatter(text);
  if (!split.ok) return { ok: false as const, message: split.message };
  try {
    return subagentOf(parseFrontMatter(split.yaml), split.body);
  } catch (error) {
    return { ok: false as const, message: (error as Error).message };
  }
}

// The two public marketplaces as they are published, in miniature.
const OFFICIAL = {
  name: "claude-plugins-official",
  owner: { name: "Anthropic", email: "support@anthropic.com" },
  plugins: [
    { name: "agent-sdk-dev", source: "./plugins/agent-sdk-dev", description: "Development kit", category: "development", author: { name: "Anthropic" } },
    { name: "asana", source: "./external_plugins/asana", category: "productivity", description: "Asana" },
    {
      name: "airtable",
      source: { source: "git-subdir", url: "https://github.com/Airtable/skills.git", path: "plugins/airtable", ref: "main", sha: "812ee67f1fd3d76fb45ff8df40afaa0448602ba8" },
      category: "productivity",
      description: "Airtable",
    },
    { name: "aikido", source: { source: "url", url: "https://github.com/AikidoSec/aikido-claude-plugin.git", sha: "02f018ad4da175a2a5ad6ca9451c3d309d105fab" } },
    { name: "from-npm", source: { source: "npm", package: "@acme/plugin" } },
    { name: "bad entry", source: "./x" },
    { name: "no-source" },
  ],
};

const SKILLS = {
  name: "anthropic-agent-skills",
  owner: { name: "Keith Lazuka", email: "klazuka@anthropic.com" },
  metadata: { description: "Anthropic example skills", version: "1.0.0" },
  plugins: [
    { name: "document-skills", description: "Documents", source: "./", strict: false, skills: ["./skills/xlsx", "./skills/docx", "./skills/pptx", "./skills/pdf"] },
    { name: "claude-api", description: "Claude API", source: "./", strict: false, skills: ["./skills/claude-api"] },
  ],
};

test("a marketplace manifest reads as published, noting the entries it can't read", () => {
  const read = parseMarketplaceManifest(OFFICIAL);
  assert.ok(read.ok);
  assert.equal(read.value.name, "claude-plugins-official");
  assert.equal(read.value.owner.name, "Anthropic");
  assert.deepEqual(
    read.value.plugins.map((p) => [p.name, p.source.source, p.category]),
    [
      ["agent-sdk-dev", "path", "development"],
      ["asana", "path", "productivity"],
      ["airtable", "git-subdir", "productivity"],
      ["aikido", "url", null],
      ["from-npm", "npm", null],
    ],
  );
  assert.deepEqual(read.value.problems, ["Plugin 6: A plugin's name is letters, digits, dots, underscores and hyphens, like pr-review-toolkit.", "Plugin 7: no-source has no source."]);
  const skills = parseMarketplaceManifest(SKILLS);
  assert.ok(skills.ok);
  assert.equal(skills.value.description, "Anthropic example skills");
  assert.equal(skills.value.version, "1.0.0");
  assert.deepEqual(skills.value.plugins[0]!.skills, ["skills/xlsx", "skills/docx", "skills/pptx", "skills/pdf"]);
  assert.equal(skills.value.plugins[0]!.strict, false);
});

test("a manifest without a name, an owner or plugins is refused", () => {
  assert.equal(parseMarketplaceManifest({ owner: { name: "x" }, plugins: [] }).ok, false);
  assert.equal(parseMarketplaceManifest({ name: "x", plugins: [] }).ok, false);
  assert.equal(parseMarketplaceManifest({ name: "x", owner: "Someone" }).ok, false);
  assert.equal(parseMarketplaceManifest({ name: "../x", owner: { name: "x" }, plugins: [] }).ok, false);
  assert.equal(parseMarketplaceManifest("[]").ok, false);
});

test("plugin sources: every form Claude Code takes, and what each refuses", () => {
  assert.deepEqual(parsePluginSource("./plugins/foo/"), { ok: true, value: { source: "path", path: "./plugins/foo" } });
  assert.equal(parsePluginSource("plugins/foo").ok, false);
  assert.equal(parsePluginSource("./plugins/../foo").ok, false);
  assert.deepEqual(parsePluginSource({ source: "github", repo: "acme/tools", ref: "v1", sha: "ABCDEF0123456789abcdef0123456789abcdef01" }), {
    ok: true,
    value: { source: "github", repo: "acme/tools", ref: "v1", sha: "abcdef0123456789abcdef0123456789abcdef01" },
  });
  assert.equal(parsePluginSource({ source: "github", repo: "not a repo" }).ok, false);
  assert.equal(parsePluginSource({ source: "url", url: "ftp://x" }).ok, false);
  assert.equal(parsePluginSource({ source: "git-subdir", url: "https://github.com/a/b.git", path: "../x" }).ok, false);
  assert.deepEqual(parsePluginSource({ source: "archive", url: "https://x.dev/p.zip", sha256: "ab".repeat(32) }), { ok: true, value: { source: "archive", url: "https://x.dev/p.zip", sha256: "ab".repeat(32) } });
  assert.deepEqual(parsePluginSource({ source: "command", command: "make plugin", mode: "link" }), { ok: true, value: { source: "command", command: "make plugin", mode: "link" } });
  assert.equal(parsePluginSource({ source: "pip", package: "x" }).ok, false);
});

test("where to fetch a plugin from follows its source and its marketplace", () => {
  const github = { source: "github", repo: "anthropics/claude-plugins-official" } as const;
  assert.deepEqual(fetchPlan({ source: "path", path: "./plugins/agent-sdk-dev" }, github), { kind: "github", repo: "anthropics/claude-plugins-official", ref: null, sha: null, path: "plugins/agent-sdk-dev" });
  assert.deepEqual(fetchPlan({ source: "path", path: "./" }, { source: "github", repo: "anthropics/skills", ref: "main" }), { kind: "github", repo: "anthropics/skills", ref: "main", sha: null, path: "" });
  assert.deepEqual(fetchPlan({ source: "path", path: "./foo" }, { source: "g1t", repo: "flagon-io/plugins" }), { kind: "g1t", repo: "flagon-io/plugins", ref: null, path: "foo" });
  assert.deepEqual(fetchPlan({ source: "git-subdir", url: "https://github.com/Airtable/skills.git", path: "plugins/airtable", ref: "main", sha: "8".repeat(40) }, github), {
    kind: "github",
    repo: "Airtable/skills",
    ref: "main",
    sha: "8".repeat(40),
    path: "plugins/airtable",
  });
  assert.deepEqual(fetchPlan({ source: "url", url: "https://github.com/AikidoSec/aikido-claude-plugin.git", sha: "0".repeat(40) }, github), { kind: "github", repo: "AikidoSec/aikido-claude-plugin", ref: null, sha: "0".repeat(40), path: "" });
  assert.deepEqual(fetchPlan({ source: "url", url: "https://g1t.sh/flagon-io/tools" }, github, { host: "g1t.sh" }), { kind: "g1t", repo: "flagon-io/tools", ref: null, path: "" });
  assert.equal(fetchPlan({ source: "url", url: "https://gitlab.com/a/b.git" }, github).kind, "unsupported");
  assert.equal(fetchPlan({ source: "npm", package: "x" }, github).kind, "unsupported");
  assert.equal(fetchPlan({ source: "command", command: "x" }, github).kind, "unsupported");
  assert.equal(fetchPlan({ source: "path", path: "./x" }, { source: "url", url: "https://x.dev/marketplace.json" }).kind, "unsupported");
  assert.deepEqual(fetchPlan({ source: "path", path: "foo" }, github, { pluginRoot: "plugins" }), { kind: "github", repo: "anthropics/claude-plugins-official", ref: null, sha: null, path: "plugins/foo" });
  assert.deepEqual(fetchPlan({ source: "archive", url: "https://x.dev/p.zip" }, github), { kind: "archive", url: "https://x.dev/p.zip", sha256: null });
});

test("a marketplace address is read the ways people write one", () => {
  assert.deepEqual(parseMarketplaceAddress("anthropics/skills"), { ok: true, value: { source: "github", repo: "anthropics/skills" } });
  assert.deepEqual(parseMarketplaceAddress("acme/tools#v2"), { ok: true, value: { source: "github", repo: "acme/tools", ref: "v2" } });
  assert.deepEqual(parseMarketplaceAddress("https://github.com/anthropics/claude-plugins-official"), { ok: true, value: { source: "github", repo: "anthropics/claude-plugins-official" } });
  assert.deepEqual(parseMarketplaceAddress("https://github.com/acme/tools/tree/main"), { ok: true, value: { source: "github", repo: "acme/tools", ref: "main" } });
  assert.deepEqual(parseMarketplaceAddress("https://x.dev/plugins/marketplace.json"), { ok: true, value: { source: "url", url: "https://x.dev/plugins/marketplace.json" } });
  assert.deepEqual(parseMarketplaceAddress("https://gitlab.com/acme/tools.git#main"), { ok: true, value: { source: "git", url: "https://gitlab.com/acme/tools.git", ref: "main" } });
  assert.deepEqual(parseMarketplaceAddress("flagon-io/plugins", { here: (repo) => repo === "flagon-io/plugins" }), { ok: true, value: { source: "g1t", repo: "flagon-io/plugins" } });
  assert.deepEqual(parseMarketplaceAddress("https://g1t.sh/flagon-io/plugins", { host: "g1t.sh" }), { ok: true, value: { source: "g1t", repo: "flagon-io/plugins" } });
  assert.equal(parseMarketplaceAddress("").ok, false);
  assert.equal(parseMarketplaceAddress("just words").ok, false);
  assert.deepEqual(githubRepoOf("git@github.com:acme/tools.git"), { repo: "acme/tools" });
  assert.equal(githubRepoOf("https://example.com/acme/tools"), null);
});

test("names: marketplaces, reserved ones, plugins and plugin@marketplace", () => {
  assert.equal(marketplaceNameProblem("my-plugins"), null);
  assert.ok(marketplaceNameProblem("-x"));
  assert.ok(marketplaceNameProblem("a..b"));
  assert.ok(isReservedMarketplaceName("claude-plugins-official"));
  assert.ok(isReservedMarketplaceName("claudeai-foo"));
  assert.ok(isReservedMarketplaceName("g1t"));
  assert.equal(isReservedMarketplaceName("acme"), false);
  assert.equal(pluginNameProblem("pr-review-toolkit"), null);
  assert.ok(pluginNameProblem("a:b"));
  assert.ok(pluginNameProblem("a/b"));
  assert.equal(pluginRef("pdf", "anthropic-agent-skills"), "pdf@anthropic-agent-skills");
  assert.deepEqual(parsePluginRef("pdf@anthropic-agent-skills"), { name: "pdf", marketplace: "anthropic-agent-skills" });
  assert.equal(parsePluginRef("pdf"), null);
  assert.equal(parsePluginRef("@x"), null);
  assert.equal(namespaced("document-skills", "pdf"), "document-skills:pdf");
});

test("plugin.json needs only a name; component paths and inline servers are kept", () => {
  const read = parsePluginManifest({ name: "asana", description: "Asana", author: { name: "Asana" }, skills: ["./extra-skills"], mcpServers: { asana: { type: "http", url: "https://mcp.asana.com/v2/mcp" } }, hooks: "./hooks/hooks.json", other: 1 });
  assert.ok(read.ok);
  assert.deepEqual(read.value.skills, ["extra-skills"]);
  assert.deepEqual(read.value.hooks, ["hooks/hooks.json"]);
  assert.deepEqual(read.value.extra, { other: 1 });
  assert.ok(read.value.mcpServers && typeof read.value.mcpServers === "object");
  assert.equal(parsePluginManifest({ description: "no name" }).ok, false);
  assert.equal(parsePluginManifest({ name: "claude:x" }).ok, false);
});

test(".mcp.json: remote servers, stdio ones, and what is skipped", () => {
  const { servers, problems } = parseMcpServers({
    mcpServers: {
      asana: { type: "http", url: "https://mcp.asana.com/v2/mcp", headers: { Authorization: "Bearer ${ASANA_TOKEN}" } },
      legacy: { type: "sse", url: "https://x.dev/sse" },
      local: { command: "npx", args: ["-y", "@acme/server", "${HOME}"], env: { KEY: "${ACME_KEY:-none}" } },
      untyped: { url: "https://x.dev/mcp" },
      broken: "nope",
      "bad name!": { type: "http", url: "https://x.dev" },
    },
  });
  assert.deepEqual(
    servers.map((s) => [s.name, s.type, s.url ?? s.command, s.variables]),
    [
      ["asana", "http", "https://mcp.asana.com/v2/mcp", ["ASANA_TOKEN"]],
      ["legacy", "sse", "https://x.dev/sse", []],
      ["local", "stdio", "npx", ["ACME_KEY", "HOME"]],
    ],
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0]!, /untyped: a remote server says its type/);
  assert.equal(parseMcpServers([]).problems.length, 1);
});

test("a subagent file: front-matter and the prompt, skipped the way Claude Code skips it", () => {
  const read = parseSubagentFile(`---
name: code-reviewer
description: Reviews pull requests for risk. Use after a change is ready.
tools: Read, Grep, Bash
model: sonnet
skills:
  - pr-review
color: green
---

You are a careful reviewer. Read the diff first.
`);
  assert.ok(read.ok);
  assert.deepEqual(
    { name: read.value.name, tools: read.value.tools, model: read.value.model, skills: read.value.skills, color: read.value.color },
    { name: "code-reviewer", tools: ["Read", "Grep", "Bash"], model: "sonnet", skills: ["pr-review"], color: "green" },
  );
  assert.equal(read.value.prompt, "You are a careful reviewer. Read the diff first.");
  assert.equal(parseSubagentFile("no front matter").ok, false);
  assert.equal(parseSubagentFile("---\nname: x\n---\nbody").ok, false);
  assert.equal(parseSubagentFile("---\nname: a:b\ndescription: d\n---\nbody").ok, false);
  assert.equal(parseSubagentFile("---\nname: a\ndescription: d\n---\n\n").ok, false);
});

test("a plugin's layout is found from its files, its manifest and a strict entry", () => {
  const files = [
    ".claude-plugin/plugin.json",
    "README.md",
    "skills/pdf/SKILL.md",
    "skills/pdf/scripts/fill.py",
    "skills/docx/SKILL.md",
    "commands/review.md",
    "agents/reviewer.md",
    "agents/security/audit.md",
    "hooks/hooks.json",
    ".mcp.json",
    "bin/tool",
    "extra/one/SKILL.md",
  ];
  const manifest = parsePluginManifest({ name: "kit", skills: ["./extra"] });
  assert.ok(manifest.ok);
  const layout = pluginLayout(files, manifest.value, null);
  assert.deepEqual(layout.skills, [
    { path: "extra/one", name: "one" },
    { path: "skills/docx", name: "docx" },
    { path: "skills/pdf", name: "pdf" },
  ]);
  assert.deepEqual(layout.commands, [{ path: "commands/review.md", name: "review" }]);
  assert.deepEqual(layout.agents, [
    { path: "agents/reviewer.md", name: "reviewer" },
    { path: "agents/security/audit.md", name: "audit" },
  ]);
  assert.deepEqual(layout.hooks, ["hooks/hooks.json"]);
  assert.equal(layout.mcp, ".mcp.json");
  assert.equal(layout.bin, true);
  assert.equal(layout.readme, "README.md");
  // The skills marketplace: a plugin whose folder is the marketplace root, with its skills named by the entry.
  const entry = parseMarketplaceManifest(SKILLS);
  assert.ok(entry.ok);
  const docs = pluginLayout(["skills/xlsx/SKILL.md", "skills/docx/SKILL.md", "skills/pdf/SKILL.md", "skills/pptx/SKILL.md", "skills/other/SKILL.md", "README.md"], null, entry.value.plugins[0]!);
  assert.deepEqual(
    docs.skills.map((s) => s.name),
    ["docx", "other", "pdf", "pptx", "xlsx"],
  );
  // A plugin that is one skill at its root.
  assert.deepEqual(pluginLayout(["SKILL.md", "reference.md"], null, { ...entry.value.plugins[1]!, skills: ["."] }).skills, [{ path: ".", name: "claude-api" }]);
});

test("the built-in marketplaces are the public ones, under their own names", () => {
  assert.deepEqual(
    BUILTIN_MARKETPLACES.map((m) => [m.name, m.source]),
    [
      ["claude-plugins-official", { source: "github", repo: "anthropics/claude-plugins-official" }],
      ["anthropic-agent-skills", { source: "github", repo: "anthropics/skills" }],
    ],
  );
  for (const m of BUILTIN_MARKETPLACES) assert.ok(isReservedMarketplaceName(m.name));
});
