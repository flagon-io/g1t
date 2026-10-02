import { WorkerEntrypoint } from "cloudflare:workers";

import {
  type BlobView,
  type Commit,
  type CreateRepoInput,
  type EventsApi,
  type GitAccess,
  type GitService,
  type ServiceBinding,
  type NewEvent,
  type Repo,
  type RepoPath,
  type ReposApi,
  type Result,
  type TreeView,
  type User,
  type Viewer,
  fail,
  identityClient,
  isValidNamespace,
  isValidRepoName,
  newId,
  ok,
} from "@g1t/contracts";

import { ArtifactsGitStore } from "./artifacts-git-store";
import { handleGitHttp } from "./git-http";
import type { GitStore } from "./git-store";
import {
  RepoRegistry,
  canRead,
  canWrite,
  storeKey,
} from "./registry";

export interface ReposEnv {
  DB: D1Database;
  ARTIFACTS: Artifacts;
  IDENTITY: ServiceBinding;
  EVENTS: EventsApi;
}

/** Namespace that holds every attempt's fork: `attempts/<attempt id>`. */
const ATTEMPTS_NAMESPACE = "attempts";
const MAX_TEXT_BYTES = 512 * 1024;
const README = /^readme(\.(md|markdown|txt))?$/i;
const SOURCE = "repos";

const NOT_FOUND = fail("not_found", "Repository not found.");

/** Decoded text, or null when the blob is too large or looks binary. */
async function blobText(blob: Blob): Promise<string | null> {
  if (blob.size > MAX_TEXT_BYTES) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.includes(0)) return null;
  return new TextDecoder().decode(bytes);
}

export default class ReposService
  extends WorkerEntrypoint<ReposEnv>
  implements ReposApi
{
  private readonly registry = new RepoRegistry(this.env.DB);
  private readonly store: GitStore = new ArtifactsGitStore(this.env.ARTIFACTS);

  /** Resolves a repo the viewer may read; private repos look missing. */
  private async readable(path: RepoPath, viewer: Viewer): Promise<Repo | null> {
    const repo = await this.registry.byPath(path);
    return repo && canRead(repo, viewer) ? repo : null;
  }

  async get(path: RepoPath, viewer: Viewer): Promise<Result<Repo>> {
    const repo = await this.readable(path, viewer);
    return repo ? ok(repo) : NOT_FOUND;
  }

  async getById(id: string, viewer: Viewer): Promise<Result<Repo>> {
    const repo = await this.registry.byId(id);
    return repo && canRead(repo, viewer) ? ok(repo) : NOT_FOUND;
  }

  async list(
    viewer: Viewer,
    options: { query?: string; namespace?: string } = {},
  ): Promise<Repo[]> {
    return this.registry.list(viewer, options);
  }

  async create(owner: User, input: CreateRepoInput): Promise<Result<Repo>> {
    const name = input.name.trim().toLowerCase();
    if (!isValidRepoName(name)) {
      return fail("invalid", "Use letters, digits, dots, hyphens and underscores only.");
    }
    if (!isValidNamespace(owner.username)) {
      return fail("invalid", "This account cannot own repositories.");
    }
    const path = { namespace: owner.username, name };
    if (await this.registry.byPath(path)) {
      return fail("conflict", "You already have a repository with that name.");
    }
    const repo: Repo = {
      id: newId("rep"),
      ...path,
      description: input.description?.trim() || null,
      isPrivate: input.isPrivate ?? false,
      ownerId: owner.id,
      defaultBranch: "main",
      forkOf: null,
      createdAt: Date.now(),
    };
    await this.store.create(storeKey(repo), {
      description: repo.description ?? undefined,
      defaultBranch: repo.defaultBranch,
    });
    await this.registry.insert(repo);
    await this.publish({
      type: "repo.created",
      source: SOURCE,
      repoId: repo.id,
      actor: owner.id,
      data: {
        repoId: repo.id,
        namespace: repo.namespace,
        name: repo.name,
        isPrivate: repo.isPrivate,
      },
    });
    return ok(repo);
  }

  async tree(
    path: RepoPath,
    viewer: Viewer,
    ref: string | null,
    treePath: string,
  ): Promise<Result<TreeView>> {
    const repo = await this.readable(path, viewer);
    if (!repo) return NOT_FOUND;
    const key = storeKey(repo);
    const resolvedRef = ref ?? repo.defaultBranch;
    const base = { repo, ref: resolvedRef, path: treePath };

    const [head] = await this.store.log(key, resolvedRef, 1);
    if (!head) {
      // An unknown ref is an error; a repo with no commits is just empty.
      if (ref) return fail("not_found", "No such branch, tag or commit.");
      return ok({ ...base, head: null, entries: [], readme: null });
    }

    let entries = await this.store.readTree(key, head.treeHash);
    for (const segment of treePath.split("/").filter(Boolean)) {
      const next = entries?.find(
        (entry) => entry.name === segment && entry.kind === "tree",
      );
      if (!next) return fail("not_found", "No such directory.");
      entries = await this.store.readTree(key, next.hash);
    }
    if (!entries) return fail("not_found", "No such directory.");
    entries.sort(
      (a, b) =>
        Number(b.kind === "tree") - Number(a.kind === "tree") ||
        a.name.localeCompare(b.name),
    );

    const readmeEntry = entries.find(
      (entry) => entry.kind === "blob" && README.test(entry.name),
    );
    const readmeBlob = readmeEntry
      ? await this.store.readBlob(key, readmeEntry.hash)
      : null;
    const readme =
      readmeEntry && readmeBlob
        ? { name: readmeEntry.name, text: await blobText(readmeBlob) }
        : null;
    return ok({ ...base, head, entries, readme });
  }

  async blob(
    path: RepoPath,
    viewer: Viewer,
    ref: string,
    filePath: string,
  ): Promise<Result<BlobView>> {
    const repo = await this.readable(path, viewer);
    if (!repo) return NOT_FOUND;
    const blob = filePath
      ? await this.store.readFile(storeKey(repo), ref, filePath)
      : null;
    if (!blob) return fail("not_found", "No such file.");
    return ok({
      repo,
      ref,
      path: filePath,
      size: blob.size,
      text: await blobText(blob),
    });
  }

  async log(
    path: RepoPath,
    viewer: Viewer,
    ref: string | null,
    limit: number,
  ): Promise<Result<Commit[]>> {
    const repo = await this.readable(path, viewer);
    if (!repo) return NOT_FOUND;
    return ok(
      await this.store.log(storeKey(repo), ref ?? repo.defaultBranch, limit),
    );
  }

  async forkForAttempt(
    sourceId: string,
    attemptId: string,
    actor: User,
  ): Promise<Result<Repo>> {
    const source = await this.registry.byId(sourceId);
    if (!source || !canRead(source, actor)) return NOT_FOUND;
    const fork: Repo = {
      id: newId("rep"),
      namespace: ATTEMPTS_NAMESPACE,
      name: attemptId,
      description: null,
      // A fork is exactly as visible as the repo it came from.
      isPrivate: source.isPrivate,
      ownerId: actor.id,
      defaultBranch: source.defaultBranch,
      forkOf: source.id,
      createdAt: Date.now(),
    };
    await this.store.fork(storeKey(source), storeKey(fork));
    await this.registry.insert(fork);
    await this.publish({
      type: "repo.forked",
      source: SOURCE,
      repoId: source.id,
      actor: actor.id,
      data: { repoId: fork.id, sourceRepoId: source.id, attemptId },
    });
    return ok(fork);
  }

  async gitAccess(
    path: RepoPath,
    viewer: Viewer,
    service: GitService,
  ): Promise<Result<GitAccess>> {
    const write = service === "git-receive-pack";
    let repo = await this.registry.byPath(path);
    if (!repo) {
      // Push to create, in the pusher's own namespace only.
      if (!write || !viewer || viewer.username !== path.namespace.toLowerCase()) {
        return this.denied(viewer);
      }
      const created = await this.create(viewer, { name: path.name });
      if (!created.ok) return created;
      repo = created.value;
    } else if (write ? !canWrite(repo, viewer) : !canRead(repo, viewer)) {
      return this.denied(viewer);
    }
    return ok(await this.store.access(storeKey(repo), write ? "write" : "read"));
  }

  /**
   * Anonymous callers are asked to authenticate whether or not the repo
   * exists, so private repos cannot be told apart from missing ones.
   */
  private denied(viewer: Viewer): Result<never> {
    return viewer
      ? NOT_FOUND
      : fail("unauthenticated", "Authentication required.");
  }

  private async publish(event: NewEvent): Promise<void> {
    await this.env.EVENTS.publish([event]);
  }

  /** Git over HTTPS. */
  async fetch(request: Request): Promise<Response> {
    const response = await handleGitHttp(request, identityClient(this.env.IDENTITY), this, (path) =>
      this.ctx.waitUntil(this.pushed(path)),
    );
    return response ?? new Response("Not found\n", { status: 404 });
  }

  /**
   * Publishes `git.push` after a push has gone through the git front end.
   * Artifacts' own push subscriptions are per repository, which does not fit
   * a repo per attempt, so the front end reports pushes itself.
   */
  private async pushed(path: RepoPath): Promise<void> {
    const repo = await this.registry.byPath(path);
    if (!repo) return;
    const [head] = await this.store.log(storeKey(repo), repo.defaultBranch, 1);
    if (!head) return;
    await this.publish({
      type: "git.push",
      source: SOURCE,
      repoId: repo.id,
      actor: null,
      data: {
        repoId: repo.id,
        ref: `refs/heads/${repo.defaultBranch}`,
        after: head.hash,
      },
    });
  }
}
