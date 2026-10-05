/**
 * Reading a repository's instructions for agents through the repos
 * service: for a run's prompt, and for the project's Agents page.
 */
import {
  type RepoInstructions,
  type RepoPath,
  type Result,
  type ServiceBinding,
  type User,
  type Viewer,
  ok,
  reposClient,
  workClient,
} from "@g1t/contracts";

import {
  INSTRUCTION_FILES,
  type InstructionTask,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
  REVIEW_FILE,
  type TreeReader,
  cachedReader,
  describeRead,
  loadInstructions,
  pathsIn,
  remember,
  renderInstructions,
} from "./instructions";

/** How many top-level directories the Agents page looks in. */
const MAX_LISTED_DIRECTORIES = 30;

/** A repository at its commits, read as `viewer`, cached by commit. */
export function treeReader(repos: ServiceBinding, path: RepoPath, viewer: Viewer, repoId: string): TreeReader {
  const client = reposClient(repos);
  return cachedReader(
    {
      resolve: async (ref) => {
        const tree = await client.tree(path, viewer, ref, "");
        return tree.ok ? (tree.value.head?.hash ?? null) : null;
      },
      list: async (commit, dir) => {
        const tree = await client.tree(path, viewer, commit, dir);
        return tree.ok ? tree.value.entries.filter((entry) => entry.kind === "blob" || entry.kind === "exec").map((entry) => entry.name) : null;
      },
      read: async (commit, file) => {
        const blob = await client.blob(path, viewer, commit, file);
        return blob.ok ? blob.value.text : null;
      },
    },
    repoId,
  );
}

/**
 * `actor` as a viewer who can read the repository: someone g1t works for
 * there is a member of its workspace, though a stored author carries no
 * memberships.
 */
export function asMember(actor: User, repo: RepoPath): User {
  const slug = repo.namespace.toLowerCase();
  const workspaces = actor.workspaces ?? [];
  if (workspaces.some((membership) => membership.slug.toLowerCase() === slug)) return actor;
  return { ...actor, workspaces: [...workspaces, { slug, role: "member" }] };
}

/**
 * The repository's instructions for one agent run, as its prompt gives
 * them, and noted in the pull request's session when there is one. For a
 * run on a pull request, read at its head too: followed only from a branch
 * of the repository itself, never from a fork. Never holds up a run.
 */
export async function instructionsFor(
  env: { REPOS: ServiceBinding; WORK: ServiceBinding },
  input: {
    task: InstructionTask;
    actor: User;
    repo: RepoPath;
    /** The pull request the run is on, if it is on one. */
    pull?: number | null;
    /** What the task is about, for the paths it names. */
    about?: string;
    /** Note what was read in the pull request's session. */
    note?: boolean;
  },
): Promise<string | null> {
  try {
    const viewer = asMember(input.actor, input.repo);
    const found = await reposClient(env.REPOS).get(input.repo, viewer);
    if (!found.ok) return null;
    const base = treeReader(env.REPOS, input.repo, viewer, found.value.id);
    const touched = pathsIn(input.about ?? "");
    let head: { reader: TreeReader; ref: string; inRepo: boolean } | null = null;
    if (input.pull) {
      const detail = await workClient(env.WORK).getPull(input.repo, input.pull, viewer);
      if (detail.ok) {
        const { pull } = detail.value;
        touched.push(...pull.files.map((file) => file.path));
        if (pull.fork) {
          const fork = await reposClient(env.REPOS).get(pull.fork, viewer);
          if (fork.ok && pull.headCommit) {
            head = { reader: treeReader(env.REPOS, pull.fork, viewer, fork.value.id), ref: pull.headCommit, inRepo: false };
          }
        } else if (pull.branch) {
          head = { reader: base, ref: pull.headCommit ?? pull.branch, inRepo: true };
        }
      }
    }
    const instructions = await loadInstructions({
      base,
      baseRef: found.value.defaultBranch,
      head,
      touched,
      task: input.task,
    });
    const read = describeRead(instructions);
    if (read && input.note && input.pull) {
      await workClient(env.WORK)
        .appendSession(input.actor, input.repo, input.pull, [{ kind: "note", text: read }])
        .catch(() => undefined);
    }
    return renderInstructions(instructions);
  } catch (error) {
    console.log("instructions not read", input.repo.namespace, input.repo.name, String(error));
    return null;
  }
}

/** `prompt` with `block` added, when there is one. */
export function withBlock(prompt: string, block: string | null): string {
  return block ? `${prompt}\n\n${block}` : prompt;
}

/** What the project's Agents page shows: every instructions file on the default branch. */
export async function repoInstructions(
  repos: ServiceBinding,
  viewer: Viewer,
  path: RepoPath,
): Promise<Result<RepoInstructions>> {
  const client = reposClient(repos);
  const found = await client.get(path, viewer);
  if (!found.ok) return found;
  const branch = found.value.defaultBranch;
  const limits = { fileChars: MAX_FILE_CHARS, totalChars: MAX_TOTAL_CHARS };
  const root = await client.tree(path, viewer, branch, "");
  if (!root.ok || !root.value.head) return ok({ branch, commit: null, files: [], limits });
  const commit = root.value.head.hash;
  const reader = treeReader(repos, path, viewer, found.value.id);
  const names = (entries: string[] | null) => INSTRUCTION_FILES.filter((name) => (entries ?? []).includes(name));
  const rootFiles = root.value.entries.filter((entry) => entry.kind === "blob" || entry.kind === "exec").map((entry) => entry.name);
  const dirs = root.value.entries
    .filter((entry) => entry.kind === "tree" && entry.name !== ".git")
    .map((entry) => entry.name)
    .slice(0, MAX_LISTED_DIRECTORIES);
  const listed = await Promise.all(dirs.map((dir) => reader.list(commit, dir).catch(() => null)));
  const candidates: { path: string; role: RepoInstructions["files"][number]["role"] }[] = [
    ...names(rootFiles).map((name) => ({ path: name, role: "root" as const })),
    ...(dirs.includes(".g1t") && (listed[dirs.indexOf(".g1t")] ?? []).includes("review.md")
      ? [{ path: REVIEW_FILE, role: "review" as const }]
      : []),
    ...dirs.flatMap((dir, at) =>
      dir === ".g1t" ? [] : names(listed[at]).map((name) => ({ path: `${dir}/${name}`, role: "directory" as const })),
    ),
  ];
  const files = await Promise.all(
    candidates.map(async ({ path: file, role }) => {
      const [text, blame] = await Promise.all([
        reader.read(commit, file).catch(() => null),
        remember(`${found.value.id}@${commit}:blame:${file}`, () => client.blame(path, viewer, commit, file)).catch(() => null),
      ]);
      const latest = blame?.ok
        ? [...blame.value.commits].sort((a, b) => b.authoredAt.localeCompare(a.authoredAt))[0]
        : undefined;
      return {
        path: file,
        role,
        text: text ?? "",
        truncated: (text ?? "").trim().length > MAX_FILE_CHARS,
        lastChanged: latest
          ? { commit: latest.hash, message: latest.message.split("\n")[0], author: latest.author.name, at: latest.authoredAt }
          : null,
      };
    }),
  );
  return ok({ branch, commit, files, limits });
}
