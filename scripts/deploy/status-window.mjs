// Tells status.g1t.sh a deploy started or finished, so the restarts it
// causes are counted but not drafted as incidents (apps/status detect.ts:
// during the deploy and 3 minutes after; trouble that outlasts that is
// drafted with its true start).
//
//   node scripts/deploy/status-window.mjs started [id]
//   node scripts/deploy/status-window.mjs finished [id]
//
// Needs STATUS_DEPLOY_TOKEN (the status Worker's secret of the same name);
// STATUS_URL defaults to https://status.g1t.sh. Never fails a deploy:
// without the token it does nothing, and any error is a warning.
//
// scripts/deploy.mjs `deploy()` wraps its stages in `withDeployWindow`
// once there is something to ship (never in a dry run), so every deploy,
// by hand or in g1t Actions (.g1t/workflows/deploy.yml passes the
// STATUS_DEPLOY_TOKEN secret), says so. Jobs that run at once (a stage's
// matrix) each say started and finished; the status Worker counts them and
// the window closes when the last one finishes.

import { pathToFileURL } from "node:url";

/**
 * Runs `work` inside a deploy window: "started" before, "finished" after,
 * whether it succeeded or threw. Neither announcement can fail the deploy.
 *
 * @template T
 * @param {() => Promise<T>} work
 * @param {{ id?: string | null, dryRun?: boolean, announce?: typeof announceDeploy, env?: Record<string, string | undefined>, log?: (line: string) => void }} [options]
 * @returns {Promise<T>}
 */
export async function withDeployWindow(work, { id = null, dryRun = false, announce = announceDeploy, env = process.env, log } = {}) {
  if (dryRun) return work();
  const options = { id, env, ...(log ? { log } : {}) };
  await announce("started", options);
  try {
    return await work();
  } finally {
    await announce("finished", options);
  }
}

/**
 * @param {"started" | "finished"} phase
 * @param {{ id?: string | null, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, log?: (line: string) => void }} [options]
 * @returns {Promise<boolean>} whether status.g1t.sh took it
 */
export async function announceDeploy(phase, { id = null, env = process.env, fetchImpl = fetch, log = (line) => console.warn(line) } = {}) {
  const token = (env.STATUS_DEPLOY_TOKEN ?? "").trim();
  if (!token) return false;
  const base = (env.STATUS_URL || "https://status.g1t.sh").replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${base}/deploys`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase, ...(id ? { id: String(id).slice(0, 100) } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log(`status: the deploy ${phase} was not recorded (${response.status}); detection may draft restarts.`);
      return false;
    }
    return true;
  } catch (error) {
    log(`status: the deploy ${phase} was not recorded (${error instanceof Error ? error.message : String(error)}).`);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) {
  const [phase, id] = process.argv.slice(2);
  if (phase !== "started" && phase !== "finished") {
    console.error("usage: node scripts/deploy/status-window.mjs started|finished [id]");
    process.exit(2);
  }
  const ok = await announceDeploy(phase, { id: id ?? null });
  console.log(ok ? `status: deploy ${phase}` : "status: not recorded (no STATUS_DEPLOY_TOKEN, or status did not answer)");
}
