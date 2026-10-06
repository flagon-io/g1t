// The review prompt, taken from the runner's own source so the benchmark
// measures what production runs. crates/runner/src/review.rs holds the
// instructions as a Rust string constant; services/runner/src/index.ts
// (startReviewRun) puts "what the pull request is" in front of them.
//
// Production also appends repository instructions (AGENTS.md, CLAUDE.md,
// .g1t/review.md), workspace memory and the context hub. Benchmark repos
// have none of g1t's memory, so only the repository files apply; Claude
// Code reads CLAUDE.md from the checkout by itself, as it does in a
// trusted production run.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REVIEW_RS = fileURLToPath(new URL("../../crates/runner/src/review.rs", import.meta.url));

/** The `INSTRUCTIONS` constant of review.rs, unescaped as rustc would. */
export function instructionsFromRust(source = readFileSync(REVIEW_RS, "utf8")) {
  const match = source.match(/const INSTRUCTIONS: &str = "([\s\S]*?)";\n/);
  if (!match) throw new Error("INSTRUCTIONS not found in review.rs; update bench/reviewbench/prompt.mjs");
  return match[1]
    // A backslash at the end of a line continues the string and eats the
    // next line's leading whitespace.
    .replace(/\\\n\s*/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

export { buildPrompt } from "./agent/prompt-lib.mjs";

// `node prompt.mjs` writes instructions.txt for the image build, and
// `node prompt.mjs --check` fails when it has drifted from review.rs.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL("./agent/instructions.txt", import.meta.url));
  const text = instructionsFromRust();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(out, "utf8");
    } catch {}
    if (current !== text) {
      console.error("bench/reviewbench/agent/instructions.txt is out of date; run node bench/reviewbench/prompt.mjs");
      process.exit(1);
    }
  } else {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, text);
    console.log(`wrote ${out} (${text.length} chars)`);
  }
}
