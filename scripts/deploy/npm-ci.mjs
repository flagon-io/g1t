// `npm ci` that survives a dropped connection: run as
//
//   node scripts/deploy/npm-ci.mjs [npm ci's flags…]
//
// npm retries a request that fails before its answer starts, but not one
// whose body breaks off midway (`ECONNRESET`, `network aborted`), and an
// install can also stall with nothing more arriving. Either fails a whole
// job that passes when run again. So an install whose output names a
// network failure, or that ends without saying why, is run again (up to
// `ATTEMPTS` times, after `WAITS_MS`), and one that goes `STALL_MS`
// without a line of output is stopped and run again. npm's cache keeps
// what the failed attempt already fetched, so a second try is quick.
// Anything else, such as a lockfile out of step, fails at once.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ATTEMPTS = 3;
export const WAITS_MS = [5_000, 15_000];
/** How long an install may print nothing before it counts as stalled. */
export const STALL_MS = Number(process.env.G1T_NPM_STALL_MS) || 12 * 60_000;

/** npm's words for a connection that failed: worth trying again. */
const NETWORK =
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|EPIPE|ERR_SOCKET_TIMEOUT)\b|network aborted|socket hang up|network timeout|request to \S+ failed/i;

/**
 * Whether a failed install is worth running again: its output names a
 * network failure, it stalled, or it failed without an `npm error` line
 * that says why (a dropped connection can end npm before it writes one).
 */
export function retryable(output, { stalled = false } = {}) {
  if (stalled) return true;
  if (NETWORK.test(output)) return true;
  return !/^npm (error|ERR!)/m.test(output);
}

/** The npm arguments for these flags: `ci` and the flags as given. */
export function npmArgs(flags) {
  return ["ci", ...flags];
}

/** One install: its exit code, what it printed, and whether it stalled. */
function attempt(args, { stallMs, onLine }) {
  return new Promise((resolve) => {
    const child = spawn("npm", args, { shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stalled = false;
    let timer;
    const quiet = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        child.kill("SIGKILL");
      }, stallMs);
    };
    quiet();
    const take = (stream, out) =>
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        output += text;
        out.write(text);
        onLine?.(text);
        quiet();
      });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: stalled ? 1 : (code ?? 1), output, stalled });
    });
  });
}

/** Runs `npm ci` with `flags`, again when it fails in a way worth retrying. Resolves to its exit code. */
export async function npmCi(
  flags,
  { attempts = ATTEMPTS, waits = WAITS_MS, stallMs = STALL_MS, run = attempt, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.error } = {},
) {
  const args = npmArgs(flags);
  for (let tries = 1; ; tries++) {
    const done = await run(args, { stallMs });
    if (done.code === 0) return 0;
    const why = done.stalled ? `printed nothing for ${Math.round(stallMs / 1000)} s` : `exited ${done.code}`;
    if (tries >= attempts || !retryable(done.output, done)) {
      log(`npm ci ${why}${tries > 1 ? ` on try ${tries} of ${attempts}` : ""}; not trying again.`);
      return done.code || 1;
    }
    const wait = waits[Math.min(tries - 1, waits.length - 1)];
    log(`npm ci ${why}, which looks like a dropped connection: trying again in ${wait / 1000} s (try ${tries + 1} of ${attempts}).`);
    await sleep(wait);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await npmCi(process.argv.slice(2));
}
