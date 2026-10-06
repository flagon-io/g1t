/**
 * "Add CI": a starter workflow for a repository that has no checks, worked
 * out from what is at its root (lib/starter-workflow.ts), committed on a
 * new branch as the person asking and opened as their pull request. Its
 * runs then become the repository's checks, and it can be required.
 */
import type { RepoPath, User } from "@g1t/contracts";

import { repos, work } from "./services.server";
import { STARTER_PATH, freeBranch, starterDescription, starterWorkflow } from "./starter-workflow";

export type AddedCi = { number: number };

export async function addCi(user: User, path: RepoPath): Promise<{ ok: true; value: AddedCi } | { ok: false; message: string }> {
  const repo = await repos.get(path, user);
  if (!repo.ok) return { ok: false, message: repo.error.message };
  const defaultBranch = repo.value.defaultBranch;
  const [root, branches] = await Promise.all([repos.tree(path, user, null, ""), repos.branches(path, user)]);
  if (!root.ok) return { ok: false, message: root.error.message };
  if (!root.value.head) return { ok: false, message: `${defaultBranch} has no commits yet. Push a first commit, then add CI.` };
  const names = root.value.entries.map((entry) => entry.name);
  const packageJson = names.includes("package.json")
    ? await repos.blob(path, user, defaultBranch, "package.json").then((found) => (found.ok ? found.value.text : null))
    : null;
  const { yaml, stacks } = starterWorkflow({ names, packageJson }, defaultBranch);
  const branch = freeBranch(branches.ok ? branches.value.map((known) => known.name) : []);
  const committed = await repos.commitFile(path, user, {
    branch,
    path: STARTER_PATH,
    content: yaml,
    message: "Add CI workflow",
  });
  if (!committed.ok) return { ok: false, message: committed.error.message };
  const opened = await work.openPull(user, path, {
    branch,
    title: "Add CI",
    body: starterDescription(stacks, defaultBranch),
    agent: user.username,
    runtime: "external",
  });
  if (!opened.ok) return { ok: false, message: opened.error.message };
  return { ok: true, value: { number: opened.value.number } };
}
