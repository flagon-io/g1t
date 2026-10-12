#!/usr/bin/env node
// Compares what the Conformance workflow (.g1t/workflows/conformance.yml)
// saw on GitHub with what it saw on g1t: each run's `conformance-report`
// artifact, conformance.json. What GitHub has and g1t lacks, or has of
// another type, and every check whose value differs, is a difference, and
// the exit code is 1. What g1t has beyond GitHub is listed, as g1t's own.
//
//   node scripts/conformance-diff.mjs github.json g1t.json

import { readFileSync } from "node:fs";

/** The differences between `github`'s and `g1t`'s reports, by section. */
export function compare(github, g1t) {
  const found = { missing: [], different: [], extra: [] };
  const mapping = (section, theirs = {}, ours = {}) => {
    for (const [key, value] of Object.entries(theirs)) {
      if (!(key in ours)) found.missing.push(`${section} ${key} (${value})`);
      else if (ours[key] !== value) found.different.push(`${section} ${key}: GitHub ${JSON.stringify(value)}, g1t ${JSON.stringify(ours[key])}`);
    }
    for (const [key, value] of Object.entries(ours)) {
      if (!(key in theirs)) found.extra.push(`${section} ${key} (${value})`);
    }
  };
  mapping("variable", github.variables, g1t.variables);
  mapping("layout", github.layout, g1t.layout);
  for (const name of new Set([...Object.keys(github.contexts ?? {}), ...Object.keys(g1t.contexts ?? {})])) {
    mapping(`${name}.`, github.contexts?.[name], g1t.contexts?.[name]);
  }
  mapping("event", github.event ?? {}, g1t.event ?? {});
  mapping("check", github.checks, g1t.checks);
  return found;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [githubFile, g1tFile] = process.argv.slice(2);
  if (!githubFile || !g1tFile) {
    console.error("usage: node scripts/conformance-diff.mjs github.json g1t.json");
    process.exit(2);
  }
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const found = compare(read(githubFile), read(g1tFile));
  const section = (title, items) => {
    if (items.length === 0) return;
    console.log(`${title} (${items.length})`);
    for (const item of items) console.log(`  ${item}`);
  };
  section("On GitHub, not on g1t", found.missing);
  section("Different on g1t", found.different);
  section("Only on g1t", found.extra);
  const failing = found.missing.length + found.different.length;
  console.log(failing === 0 ? "g1t matches GitHub." : `${failing} differences from GitHub.`);
  process.exit(failing === 0 ? 0 : 1);
}
