import { data } from "react-router";

import {
  type Capability,
  type Repo,
  type Result,
  type Viewer,
  abilities,
  can,
  granted,
  httpStatus,
  needs,
  permission,
} from "@g1t/contracts";

import type { ViewerAccess } from "./access";
import { repos, work } from "./services.server";
import { getViewer } from "./session.server";

type Context = Parameters<typeof getViewer>[0];
type RepoParams = { owner?: string; repo?: string };

/**
 * One count of a project's open issues and pull requests per request: the
 * sidebar (root) and the project's tabs (its layout) both show them.
 */
const tallies = new WeakMap<object, Map<string, ReturnType<typeof work.counts>>>();

export function countsFor(context: Context, params: RepoParams): ReturnType<typeof work.counts> {
  const key = `${params.owner}/${params.repo}`.toLowerCase();
  let seen = tallies.get(context);
  if (!seen) tallies.set(context, (seen = new Map()));
  let found = seen.get(key);
  if (!found) {
    found = work.counts({ namespace: params.owner ?? "", name: params.repo ?? "" }, getViewer(context));
    seen.set(key, found);
  }
  return found;
}

/**
 * The repositories of these ids the viewer can read: one call for all of
 * them, then one each for any it leaves out (forks).
 */
export async function readableRepos(ids: string[], viewer: Viewer): Promise<Repo[]> {
  if (ids.length === 0) return [];
  const found = await repos.readable(ids, viewer).catch(() => [] as Repo[]);
  const seen = new Set(found.map((repo) => repo.id));
  const rest = await Promise.all(ids.filter((id) => !seen.has(id)).map((id) => repos.getById(id, viewer).catch(() => null)));
  return [...found, ...rest.flatMap((repo) => (repo?.ok ? [repo.value] : []))];
}

/**
 * One lookup of a repository per request: the repository's layout and the
 * page under it load at the same time and both need it.
 */
const lookups = new WeakMap<object, Map<string, Promise<Result<Repo>>>>();

export function repoFor(context: Context, params: RepoParams): Promise<Result<Repo>> {
  const key = `${params.owner}/${params.repo}`.toLowerCase();
  let seen = lookups.get(context);
  if (!seen) lookups.set(context, (seen = new Map()));
  let found = seen.get(key);
  if (!found) {
    found = repos.get({ namespace: params.owner ?? "", name: params.repo ?? "" }, getViewer(context));
    seen.set(key, found);
  }
  return found;
}

/** The viewer's role on a repository and what it lets them do. */
export function accessFor(viewer: Viewer, repo: Repo): ViewerAccess {
  return {
    role: permission(viewer, repo),
    // A role of their own, not only because the repository is public.
    insider: viewer ? granted(viewer, repo) != null : false,
    can: abilities(viewer, repo),
  };
}

/**
 * The repository and the viewer's access to it, refusing with a 404 when
 * they cannot read it and a 403 that says which role is needed when they
 * can read it but not do `capability`.
 */
export async function requireRepo(context: Context, params: RepoParams, capability: Capability = "read") {
  const viewer = getViewer(context);
  const found = await repoFor(context, params);
  if (!found.ok) {
    if (found.error.code === "not_found" || found.error.code === "forbidden") throw data(null, { status: 404 });
    throw data(found.error.message, { status: httpStatus(found.error) });
  }
  const access = accessFor(viewer, found.value);
  if (!access.can.read) throw data(null, { status: 404 });
  if (!access.can[capability]) throw data(needs(capability), { status: 403 });
  return { viewer, repo: found.value, access };
}

/**
 * Pages only people with a role of their own see (plans, memory,
 * deployments, security, settings): a 404 for anyone else, as before.
 */
export async function requireInsider(context: Context, params: RepoParams, capability: Capability = "read") {
  const found = await requireRepo(context, params, "read");
  if (!found.access.insider) throw data(null, { status: 404 });
  if (!found.access.can[capability]) throw data(needs(capability), { status: 403 });
  return found;
}

/** The viewer's access, or none when the repository cannot be read. */
export async function accessTo(context: Context, params: RepoParams): Promise<ViewerAccess> {
  const found = await repoFor(context, params);
  return found.ok ? accessFor(getViewer(context), found.value) : { role: null, insider: false, can: abilities(null, { id: "", namespace: "", isPrivate: true }) };
}

/**
 * For an action: why the viewer may not do `capability` here, or null when
 * they may. Not cached, since the action may change the repository.
 */
export async function refusal(context: Context, params: RepoParams, capability: Capability): Promise<string | null> {
  const viewer = getViewer(context);
  const found = await repos.get({ namespace: params.owner ?? "", name: params.repo ?? "" }, viewer);
  if (!found.ok) return found.error.message;
  return can(viewer, found.value, capability) ? null : needs(capability);
}

/** For an action whose page only people with `capability` see: a 403 that says why, otherwise nothing. */
export async function requireCapability(context: Context, params: RepoParams, capability: Capability): Promise<void> {
  const refused = await refusal(context, params, capability);
  if (refused) throw data(refused, { status: 403 });
}
