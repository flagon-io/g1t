// How CI's Rust job (.g1t/workflows/ci.yml) splits the workspace's crates
// into its parts. The parts run at once and the slowest sets CI's time, so
// they are split by how long each crate takes to test, not by how many
// there are: the longest first, each into the part with the least so far.
//
//   node scripts/deploy/ci-parts.mjs           the parts and their seconds
//   node scripts/deploy/ci-parts.mjs --write   writes them into ci.yml
//
// ci-parts.test.mjs checks ci.yml's parts are these, and that every crate
// in them has a time; repository_workflows.rs checks every workspace crate
// is in exactly one part. A new crate needs a time below: measure it as
// SECONDS says, or start from a like crate's, and write the parts again.
// Moving a crate starts its new part's test build cache over, once.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const CI = fileURLToPath(new URL("../../.g1t/workflows/ci.yml", import.meta.url));

/** How many parts the Rust job runs. */
export const PARTS = 3;

/** The CPUs a part's machine compiles on at once. */
export const CPUS = 4;

/**
 * Each crate's seconds: [compiling the targets only its own tests need,
 * running its tests]. The first is the sum of those targets' times in
 * `cargo test --workspace --no-run --timings` with the dependencies built,
 * as a part's restored cache has them; a library other crates use is
 * compiled in every part that tests one of them, so its own compile counts
 * for none. The second is `cargo test -p <crate>` once built. Both from
 * g1t's runner image at 4 CPUs with CI's RUSTFLAGS and debug info,
 * 2026-10-21.
 */
export const SECONDS = {
  "g1t-work": [26, 16.9],
  "g1t-contracts": [47, 4.8],
  "g1t-api": [33, 0.7],
  g1t: [19, 3.9],
  "g1t-runner": [21, 3.4],
  "g1t-identity": [28, 0.2],
  "g1t-repos": [25, 0.5],
  "g1t-packages": [16, 1.5],
  "g1t-billing": [20, 0.1],
  "g1t-security": [19, 0.3],
  "g1t-actions-service": [16, 0.3],
  "g1t-integrations": [11, 0.2],
  "g1t-events": [9, 0.4],
  "g1t-search": [7, 0.2],
  "g1t-scan": [3, 0.6],
  "g1t-actions": [3, 0.2],
  "g1t-rules": [3, 0.1],
  "g1t-webhooks": [3, 0.1],
  "g1t-kit": [2, 0.1],
  "g1t-sshd": [1, 0.1],
  "g1t-blobstore": [1, 0.1],
  "g1t-secrets": [0, 0.1],
};

/**
 * What a crate adds to its part's time: a part compiles on every CPU at
 * once but runs its test binaries one after another, so a quarter of its
 * compile and all of its tests. (Counted whole, compile made g1t-work's
 * part the slowest: its tests alone run 17 s.)
 */
export function cost([compile, run]) {
  return compile / CPUS + run;
}

/**
 * The crates in `parts` parts, longest first into the part with the least
 * so far (a tie goes to the earlier part, and crates of equal time go by
 * name, so the split is the same every time). Each part: its crates,
 * longest first, and its seconds.
 */
export function split(seconds, parts = PARTS) {
  const out = Array.from({ length: parts }, () => ({ crates: [], seconds: 0 }));
  const crates = Object.entries(seconds)
    .map(([name, times]) => [name, cost(times)])
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  for (const [name, time] of crates) {
    const least = out.reduce((min, part) => (part.seconds < min.seconds ? part : min));
    least.crates.push(name);
    least.seconds += time;
  }
  return out;
}

const LINE = /^(\s*crates:)((?:\s+-p\s+\S+)+)\s*$/;

/** The crates of each part in ci.yml's matrix, in order. */
export function ciParts(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(LINE))
    .filter(Boolean)
    .map((m) =>
      m[2]
        .trim()
        .split(/\s+/)
        .filter((word) => word !== "-p"),
    );
}

/** ci.yml with its parts' crates replaced by `parts`, one `crates:` line each. */
export function withParts(text, parts) {
  let at = 0;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = text.split(eol).map((line) => {
    const m = line.match(LINE);
    if (!m) return line;
    const part = parts[at++];
    if (!part) throw new Error("ci.yml has more parts than the split");
    return `${m[1]} ${part.map((name) => `-p ${name}`).join(" ")}`;
  });
  if (at !== parts.length) throw new Error(`ci.yml has ${at} parts, the split ${parts.length}`);
  return out.join(eol);
}

function main(args) {
  const parts = split(SECONDS);
  parts.forEach((part, i) => console.log(`Rust (${i + 1}) ${part.seconds.toFixed(0)}s: ${part.crates.join(", ")}`));
  if (args.includes("--write")) {
    writeFileSync(
      CI,
      withParts(
        readFileSync(CI, "utf8"),
        parts.map((p) => p.crates),
      ),
    );
    console.log(`wrote ${CI}`);
  }
}

if (process.argv[1] && basename(process.argv[1]) === "ci-parts.mjs") main(process.argv.slice(2));
