// Runs one npm script in several workspaces at once, for CI's TypeScript
// job:
//
//   node scripts/deploy/ci-workspaces.mjs <script> [workspace...]
//
// Each workspace's `npm run <script>` runs as soon as a slot is free (as
// many slots as the machine has CPUs, or G1T_CI_CONCURRENCY), the largest
// first so the longest one starts at once. What each prints is kept and
// shown together when it ends, folded in a group when it passed and in
// full with an error annotation when it failed, then a line for each with
// how long it took. It fails when any of them did, after all have run. No
// workspace given runs none, and passes.

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { basename } from "node:path";

/** Which workspaces start first: the apps, then the services, then the rest, as named. */
export function order(names) {
  const rank = (name) => (/^@g1t\/(web|sudo|mobile|docs)$/.test(name) ? 0 : 1);
  return [...names].sort((a, b) => rank(a) - rank(b));
}

/** Runs `run(item)` for every item, at most `limit` at once; resolves to their results, in order. */
export async function pool(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await run(items[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** One workspace's script: its exit code, what it printed and how long it took. */
function runOne(script, workspace) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("npm", ["run", script, "--workspace", workspace], {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const done = (code) => resolve({ workspace, code, output, seconds: (Date.now() - started) / 1000 });
    child.on("error", (error) => {
      output += `${error.message}\n`;
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

/** What a finished workspace prints: a folded group when it passed, everything and an error when not. */
export function report(script, { workspace, code, output, seconds }) {
  const head = `${workspace}: ${script} ${code === 0 ? "passed" : `failed (exit ${code})`} in ${seconds.toFixed(1)}s`;
  if (code === 0) return `::group::${head}\n${output.trimEnd()}\n::endgroup::\n`;
  return `${head}\n${output.trimEnd()}\n::error title=${workspace}::${script} failed\n`;
}

async function main([script, ...workspaces]) {
  if (!script) throw new Error("usage: node scripts/deploy/ci-workspaces.mjs <script> [workspace...]");
  if (!workspaces.length) {
    console.log(`No workspace to run ${script} in.`);
    return true;
  }
  const limit = Number(process.env.G1T_CI_CONCURRENCY) || availableParallelism();
  const started = Date.now();
  console.log(`${script} in ${workspaces.length} workspaces, ${Math.min(limit, workspaces.length)} at a time: ${workspaces.join(" ")}`);
  const results = await pool(order(workspaces), limit, async (workspace) => {
    const result = await runOne(script, workspace);
    process.stdout.write(report(script, result));
    return result;
  });
  const failed = results.filter((r) => r.code !== 0);
  console.log(`\n${script}: ${results.length - failed.length} passed, ${failed.length} failed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const r of results.sort((a, b) => b.seconds - a.seconds))
    console.log(`  ${r.code === 0 ? "ok  " : "FAIL"} ${r.seconds.toFixed(1).padStart(6)}s  ${r.workspace}`);
  return failed.length === 0;
}

if (process.argv[1] && basename(process.argv[1]) === "ci-workspaces.mjs") {
  main(process.argv.slice(2)).then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
