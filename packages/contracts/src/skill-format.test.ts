import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_TOOL_NAMES,
  RESERVED_SKILL_NAMES,
  SKILL_FOLDER_MAX_BYTES,
  checkSkillFolder,
  foundationalSkillMd,
  parseFrontMatter,
  renderSkillMd,
  skillFileBytes,
  skillNameProblem,
  splitFrontMatter,
} from "./skill-format.ts";
import { FOUNDATIONAL_SKILLS, FOUNDATIONAL_SKILL_IDS } from "./skills.ts";

test("front-matter as SKILL.md files write it", () => {
  const front = parseFrontMatter(
    [
      "name: pdf-forms",
      "description: >",
      "  Use when filling PDF forms:",
      "  text fields and checkboxes.",
      "",
      "  Not for scans.",
      "license: 'Apache-2.0'",
      "allowed-tools: Read Write",
      "tools:",
      "  - make_file",
      "  - read_artifact",
      "requires_computer: true",
      "version: 2",
      "metadata:",
      "  author: \"Ana \\\"A\\\" Lima\"",
      "  tags: [forms, \"pdf, docs\"]",
      "notes: |",
      "  line one",
      "    indented",
      "# a comment",
      "plain: words: with a colon # and a comment",
      "",
    ].join("\n"),
  );
  assert.deepEqual(front, {
    name: "pdf-forms",
    description: "Use when filling PDF forms: text fields and checkboxes.\nNot for scans.\n",
    license: "Apache-2.0",
    "allowed-tools": "Read Write",
    tools: ["make_file", "read_artifact"],
    requires_computer: true,
    version: 2,
    metadata: { author: 'Ana "A" Lima', tags: ["forms", "pdf, docs"] },
    notes: "line one\n  indented\n",
    plain: "words: with a colon",
  });
  // Lists at the key's own indentation, and folded plain values.
  assert.deepEqual(parseFrontMatter("tools:\n- read_file\n- search_code\ndescription: Use when\n  reading code.\n"), { tools: ["read_file", "search_code"], description: "Use when reading code." });
  assert.throws(() => parseFrontMatter("name: a\nname: b\n"), /name is given twice/);
  assert.throws(() => parseFrontMatter("just words\n"), /line 2: expected "key: value"/);
  assert.throws(() => parseFrontMatter('name: "open\n'), /isn't closed/);
});

test("SKILL.md splits into front-matter and body, CRLF and BOM included", () => {
  const split = splitFrontMatter("﻿---\r\nname: a\r\ndescription: b\r\n---\r\n\r\n# Body\r\n");
  assert.ok(split.ok);
  assert.equal(split.ok && split.yaml, "name: a\ndescription: b\n");
  assert.equal(split.ok && split.body, "\n# Body\n");
  assert.equal(splitFrontMatter("# No front-matter").ok, false);
  assert.equal(splitFrontMatter("---\nname: a\n").ok, false);
});

test("a skill folder is checked: names, description, tools agents have, paths, size, scripts", () => {
  const md = (front: string, body = "Do the thing.") => `---\n${front}\n---\n\n${body}\n`;
  const good = checkSkillFolder([
    { path: "SKILL.md", content: md("name: release-notes\ndescription: Use when someone asks for release notes.\ntools: make_file, read_file\nlicense: MIT") },
    { path: "./resources/template.md", content: "## Added" },
    { path: "scripts/collect.sh", content: "echo hi" },
    { path: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" },
  ]);
  assert.ok(good.ok);
  if (!good.ok) return;
  assert.equal(good.skill.name, "release-notes");
  assert.deepEqual(good.skill.tools, ["make_file", "read_file"]);
  assert.equal(good.skill.requires_computer, true, "scripts need a computer");
  assert.deepEqual(good.skill.scripts, ["scripts/collect.sh"]);
  assert.deepEqual(good.skill.files.map((f) => f.path), ["assets/logo.png", "resources/template.md", "scripts/collect.sh"]);
  assert.deepEqual(good.skill.extra, { license: "MIT" });
  assert.equal(good.skill.body, "Do the thing.");

  const bad = (files: Parameters<typeof checkSkillFolder>[0], pattern: RegExp, expectName?: string) => {
    const checked = checkSkillFolder(files, { expectName });
    assert.equal(checked.ok, false, pattern.source);
    assert.match(!checked.ok ? checked.message : "", pattern);
  };
  bad([], /a folder with a SKILL\.md/);
  bad([{ path: "README.md", content: "x" }], /needs a SKILL\.md at its top/);
  bad([{ path: "SKILL.md", content: md("description: x") }], /needs a name/);
  bad([{ path: "SKILL.md", content: md("name: Release_Notes\ndescription: x") }], /lowercase letters, digits and single hyphens/);
  bad([{ path: "SKILL.md", content: md("name: code\ndescription: x") }], /one of g1t's foundational skills/);
  bad([{ path: "SKILL.md", content: md("name: a-b") }], /needs a description/);
  bad([{ path: "SKILL.md", content: md(`name: a\ndescription: ${"x".repeat(1025)}`) }], /at most 1024 characters/);
  bad([{ path: "SKILL.md", content: md("name: a\ndescription: x\ntools: [bash]") }], /names bash, which isn't a tool agents have/);
  bad([{ path: "SKILL.md", content: md("name: a\ndescription: x\nrequires_computer: maybe") }], /requires_computer: is true or false/);
  bad([{ path: "SKILL.md", content: md("name: a\ndescription: x", "") }], /needs instructions/);
  bad([{ path: "SKILL.md", content: md("name: a\ndescription: x") }, { path: "../etc/passwd", content: "x" }], /isn't a path a skill can hold/);
  bad([{ path: "SKILL.md", content: md("name: a\ndescription: x") }, { path: "skill.md", content: "x" }], /twice/);
  bad([{ path: "SKILL.md", content: md("name: a\ndescription: x") }, { path: "big.txt", content: "x".repeat(SKILL_FOLDER_MAX_BYTES) }], /at most 1 MB/);
  bad([{ path: "SKILL.md", content: md("name: a\ndescription: x") }], /The folder is b, but its SKILL\.md is named a/, "b");
  assert.equal(skillFileBytes({ path: "x", content: "aGk=", encoding: "base64" }), 2);
  assert.equal(skillFileBytes({ path: "x", content: "é" }), 2);
  assert.equal(skillNameProblem("x".repeat(65))?.includes("at most 64"), true);
});

test("the editor writes SKILL.md that reads back the same", () => {
  const written = renderSkillMd({
    name: "brand-voice",
    description: "Use when writing: posts, emails # and docs",
    tools: ["create_artifact"],
    requires_computer: true,
    body: "# Voice\r\n\r\nWarm.",
    extra: { license: "MIT", metadata: { version: "1.0", author: "acme" } },
  });
  assert.equal(
    written,
    '---\nname: brand-voice\ndescription: "Use when writing: posts, emails # and docs"\ntools: [create_artifact]\nrequires_computer: true\nlicense: MIT\nmetadata:\n  version: "1.0"\n  author: acme\n---\n\n# Voice\n\nWarm.\n',
  );
  const checked = checkSkillFolder([{ path: "SKILL.md", content: written }]);
  assert.ok(checked.ok);
  assert.equal(checked.ok && checked.skill.description, "Use when writing: posts, emails # and docs");
  assert.deepEqual(checked.ok && checked.skill.extra, { license: "MIT", metadata: { version: "1.0", author: "acme" } });
});

test("g1t's foundational skills are written in the same format, and read back as themselves", () => {
  assert.deepEqual(RESERVED_SKILL_NAMES, FOUNDATIONAL_SKILL_IDS);
  for (const skill of FOUNDATIONAL_SKILLS) {
    const md = foundationalSkillMd(skill);
    // Checked as a library skill would be, apart from the reserved name.
    const front = parseFrontMatter((splitFrontMatter(md) as { yaml: string }).yaml);
    assert.equal(front.name, skill.id);
    assert.equal(front.description, skill.when);
    assert.match(skill.when, /^Use when /);
    for (const tool of front.tools as string[]) assert.ok(AGENT_TOOL_NAMES.includes(tool), `${skill.id}: ${tool}`);
    assert.deepEqual(front.metadata, { source: "g1t", version: skill.version });
    assert.ok(md.includes(skill.instructions), `${skill.id} keeps its playbook`);
    assert.match(md, /## What works today/);
    if (skill.abilities.some((a) => a.status === "coming")) assert.match(md, /## Not yet in g1t/);
  }
});
