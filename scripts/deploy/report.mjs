// Tells g1t about a deploy run by hand, so the repository's Deployments
// page and its production card say what runs. In g1t Actions the job's
// `environment:` does this already, so nothing is sent from there.
//
// Needs a g1t token with deployments:write: G1T_DEPLOY_TOKEN, or the file
// .credentials/g1t-deploy-token. Without one, nothing is sent. Reporting
// never fails a deploy: a problem is one line in the log.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./stack.mjs";

/** Where production answers, as the Deployments page links it. */
const PRODUCTION_URL = process.env.G1T_DEPLOY_URL || "https://g1t.sh";

/** The token, or null when there is none to use. */
export function deployToken(env = process.env, root = ROOT) {
  if (env.G1T_DEPLOY_TOKEN) return env.G1T_DEPLOY_TOKEN.trim();
  const file = join(root, ".credentials", "g1t-deploy-token");
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

/** Whether this runs inside a workflow, which reports for itself. */
export function inWorkflow(env = process.env) {
  return env.GITHUB_ACTIONS === "true" || env.G1T_ACTIONS === "true";
}

/** `{ api, repo }` from a remote on g1t (e.g. https://g1t.sh/flagon-io/g1t.git), or null. */
export function g1tRemote(urls) {
  for (const url of urls) {
    const match = /^https:\/\/(g1t\.[a-z.]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
    if (match) return { api: `https://api.${match[1]}`, repo: `${match[2]}/${match[3]}` };
  }
  return null;
}

/** The branch checked out, or null when detached. */
function currentBranch() {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function remoteUrls() {
  try {
    const names = execFileSync("git", ["remote"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    return names.map((name) => execFileSync("git", ["remote", "get-url", name], { cwd: ROOT, encoding: "utf8" }).trim());
  } catch {
    return [];
  }
}

/**
 * Starts a production deployment for `head` and returns a function that
 * settles it (true: success), or null when nothing is reported.
 */
export async function reportDeployment({ head, subject, units, log, fetchImpl = fetch, env = process.env }) {
  if (inWorkflow(env)) return null;
  const token = deployToken(env);
  const remote = g1tRemote(remoteUrls());
  if (!token || !remote) return null;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "g1t-deploy" };
  const base = `${remote.api}/repos/${remote.repo}/deployments`;
  try {
    const made = await fetchImpl(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ref: currentBranch() ?? head,
        sha: head,
        environment: "production",
        production_environment: true,
        description: `${subject} (${units.join(", ")}), deployed by hand`,
      }),
    });
    if (!made.ok) {
      log(`(the deployment was not reported to g1t: ${made.status})`);
      return null;
    }
    const { id } = await made.json();
    const status = async (state) => {
      const sent = await fetchImpl(`${base}/${id}/statuses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state, environment_url: PRODUCTION_URL, description: state === "in_progress" ? "Deploying" : undefined }),
      });
      if (!sent.ok) log(`(the deployment's ${state} was not reported to g1t: ${sent.status})`);
    };
    await status("in_progress");
    log(`Reported to g1t as deployment ${id} of ${remote.repo}.`);
    return async (ok) => {
      try {
        await status(ok ? "success" : "failure");
      } catch (error) {
        log(`(the deployment's result was not reported to g1t: ${error.message ?? error})`);
      }
    };
  } catch (error) {
    log(`(the deployment was not reported to g1t: ${error.message ?? error})`);
    return null;
  }
}
