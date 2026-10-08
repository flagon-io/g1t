/**
 * What the security pages ask the services for beyond one call: the
 * activation's price (always the price book's, through billing), and
 * "Set up code scanning", which commits the starter workflow on a new
 * branch as the person asking and opens it as their pull request, as
 * "Add CI" does.
 */
import { type RepoPath, STARTER_WORKFLOW_PATH, type User, type Viewer } from "@g1t/contracts";

import { billing, repos, work } from "./services.server";
import { codeScanningBranch, codeScanningPullBody, codeScanningWorkflow } from "./security-suite";

/** The Security and quality activation's monthly price, in cents, or null. */
export async function activationPrice(workspace: string, viewer: Viewer): Promise<number | null> {
  const states = await billing.features(workspace, viewer).catch(() => null);
  if (!states?.ok) return null;
  return states.value.find((state) => state.plan.feature === "security")?.plan.monthlyCents ?? null;
}

export async function setupCodeScanning(user: User, path: RepoPath): Promise<{ ok: true; number: number } | { ok: false; message: string }> {
  const repo = await repos.get(path, user);
  if (!repo.ok) return { ok: false, message: repo.error.message };
  const defaultBranch = repo.value.defaultBranch;
  const branches = await repos.branches(path, user);
  const branch = codeScanningBranch(branches.ok ? branches.value.map((known) => known.name) : []);
  const committed = await repos.commitFile(path, user, {
    branch,
    path: STARTER_WORKFLOW_PATH,
    content: codeScanningWorkflow(defaultBranch),
    message: "Add code scanning",
  });
  if (!committed.ok) return { ok: false, message: committed.error.message };
  const opened = await work.openPull(user, path, {
    branch,
    title: "Add code scanning",
    body: codeScanningPullBody(defaultBranch),
    agent: user.username,
    runtime: "external",
  });
  if (!opened.ok) return { ok: false, message: opened.error.message };
  return { ok: true, number: opened.value.number };
}
