import { data } from "react-router";

import {
  folioIdFrom,
  isFolioKind,
  type DocRole,
  type DocSpaceChange,
  type Folio,
  type FolioAccessChange,
  type FolioChange,
  type FolioListQuery,
  type FolioMove,
  type NewDocSpace,
  type NewFolio,
  type Result,
  type User,
} from "@g1t/contracts";

import type { Route } from "./+types/api";
import { workspacePeople } from "../../../lib/chat.server";
import { listQuery } from "../../../lib/folios";
import { docs, folios, identity, repos, work } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

/**
 * What Artifacts' pages ask for as they run, as JSON: a page of the home
 * list, link search, an artifact's sharing, history and one version,
 * templates, cards for embedded g1t things and chat's link cards; and
 * everything they change: artifacts, sharing, spaces, members,
 * suggestions, templates. Every answer is `{ ok, value }` or
 * `{ ok: false, error }`, the services' own shape.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const url = new URL(request.url);
  const q = url.searchParams;
  const answer = await safely<unknown>(async () => {
    // A page of the home list ("Show more"): the same filters as the page's address.
    if (q.has("list")) return folios.list(slug, viewer, await withOwner(listQuery(q)));
    // Words only: what `[[` and the move dialog offer as you type.
    if (q.has("search")) return folios.search(slug, viewer, { q: q.get("search") ?? "", mode: "words", limit: Number(q.get("limit")) || 10 });
    if (q.get("access")) return folios.access(slug, viewer, q.get("access")!);
    if (q.get("versions")) return folios.versions(slug, viewer, q.get("versions")!);
    if (q.get("version") && q.get("folio")) return folios.version(slug, viewer, q.get("folio")!, q.get("version")!);
    if (q.has("templates")) return folios.templates(slug, viewer, isFolioKind(q.get("templates")) ? (q.get("templates") as NewFolio["kind"]) : null);
    if (q.get("embed")) return embed(slug, q.get("embed")!, viewer, url.origin);
    // Chat's card for an artifact link, as this viewer may see it.
    if (q.get("unfurl")) return unfurl(slug, q.get("unfurl")!, viewer);
    // Repositories to cite or show the docs of: the workspace's that the viewer can read.
    if (q.has("repos")) return repositories(slug, viewer);
    // A citation's commit: the default branch's head, once the path is there.
    if (q.get("cite")) return cite(viewer, q.get("cite")!, q.get("path") ?? "");
    // How member keys show (`user:<id>`, `agent:<id>`): comment authors, people on an artifact.
    if (q.get("who")) return who(slug, viewer, q.get("who")!.split(",").slice(0, 100));
    // A member's key (`user:<id>`) by username, for sharing with them or adding them to a space.
    if (q.get("person")) {
      const user = await identity.userByUsername(q.get("person")!.toLowerCase());
      return user ? { ok: true, value: `user:${user.id}` } : { ok: false, error: { code: "not_found", message: "No such person." } };
    }
    // The workspace's teams, to share with.
    if (q.has("teams")) {
      const teams = await identity.listTeams(viewer, slug).catch(() => null);
      return { ok: true, value: teams?.ok ? teams.value.map((t) => ({ slug: t.slug, name: t.name })) : [] };
    }
    return folios.sidebar(slug, viewer);
  });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

type Sent = {
  intent?: string;
  folio_id?: string;
  space_id?: string;
  suggestion_id?: string;
  version_id?: string;
  template_id?: string;
  member?: string;
  role?: DocRole | null;
  decision?: "accept" | "reject";
  on?: boolean;
  folio?: NewFolio;
  change?: FolioChange;
  move?: FolioMove;
  access?: FolioAccessChange;
  message?: string | null;
  space?: NewDocSpace;
  space_change?: DocSpaceChange;
  name?: string;
  description?: string | null;
  repo?: string;
  id?: string;
};

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const sent = (await request.json().catch(() => ({}))) as Sent;
  const id = sent.folio_id ?? "";
  const answer = await safely(async (): Promise<Result<unknown>> => {
    switch (sent.intent) {
      case "create":
        return folios.create(slug, viewer, sent.folio ?? { kind: "doc" });
      case "update":
        return folios.update(slug, viewer, id, sent.change ?? {});
      case "move":
        return folios.move(slug, viewer, id, sent.move ?? { space_id: null, parent_id: null });
      case "duplicate":
        return folios.duplicate(slug, viewer, id);
      case "trash":
        return folios.trash(slug, viewer, id);
      case "restore":
        return folios.restore(slug, viewer, id);
      case "delete":
        return folios.delete(slug, viewer, id);
      case "favorite":
        return folios.favorite(slug, viewer, id, !!sent.on);
      case "access":
        if (!sent.access) return { ok: false, error: { code: "invalid", message: "What should change?" } };
        return folios.changeAccess(slug, viewer, id, sent.access);
      case "request_access":
        return folios.requestAccess(slug, viewer, id, sent.message ?? null);
      case "join_space":
        return folios.joinSpace(slug, viewer, sent.space_id ?? "");
      case "leave_space":
        return folios.leaveSpace(slug, viewer, sent.space_id ?? "");
      case "restore_version":
        return folios.restoreVersion(slug, viewer, id, sent.version_id ?? "");
      case "decide":
        return folios.decideSuggestion(slug, viewer, sent.suggestion_id ?? "", sent.decision === "accept" ? "accept" : "reject");
      case "save_template":
        return folios.saveTemplate(slug, viewer, { folio_id: id, name: sent.name ?? "", description: sent.description ?? null });
      case "delete_template":
        return folios.deleteTemplate(slug, viewer, sent.template_id ?? "");
      case "mark_current":
        return folios.markCurrent(slug, viewer, id);
      // Spaces are the artifacts service's own, shared with Artifacts.
      case "create_space":
        return docs.createSpace(slug, viewer, sent.space ?? ({ name: "", kind: "workspace" } as NewDocSpace));
      case "update_space":
        return docs.updateSpace(slug, sent.space_id ?? "", viewer, sent.space_change ?? {});
      case "set_member":
        return docs.setSpaceMember(slug, sent.space_id ?? "", viewer, sent.member ?? "", sent.role ?? null);
      case "add_repo_space":
        return docs.addRepoSpace(slug, viewer, sent.repo ?? "");
      case "remove_repo_space":
        return docs.removeRepoSpace(slug, viewer, sent.id ?? "");
      default:
        return { ok: false, error: { code: "invalid", message: "Unknown request." } };
    }
  });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

/** The owner filter names a person by username; the service keys people by id. */
async function withOwner(query: FolioListQuery): Promise<FolioListQuery> {
  if (!query.owner) return query;
  const user = await identity.userByUsername(query.owner.toLowerCase()).catch(() => null);
  return { ...query, owner: user ? `user:${user.id}` : "user:nobody" };
}

async function safely<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    console.error("artifacts api:", error);
    return { ok: false, error: { code: "conflict", message: "Artifacts didn't answer. Try again in a moment." } };
  }
}

/**
 * Chat's card for an artifact link, for this viewer only (plan section
 * 4.3 rule 3): its kind, title, space and last edit when they can read it;
 * `null` (no title, nothing else) when they can't or it doesn't exist.
 * Looking never records a visit: a card is not opening the link.
 */
async function unfurl(slug: string, address: string, viewer: User): Promise<Result<FolioUnfurl | null>> {
  const id = folioIdFrom(address.split(/[?#]/)[0]!.replace(/\/+$/, ""));
  if (!id) return { ok: false, error: { code: "invalid", message: "That isn't an artifact's address." } };
  const found = await folios.folio(slug, viewer, id, { peek: true });
  if (!found.ok) return { ok: true, value: null };
  const f = found.value;
  return {
    ok: true,
    value: { id: f.id, kind: f.kind, title: f.title, icon: f.icon, path: f.path, space: f.space?.name ?? null, private: f.private, excerpt: f.excerpt, edited_at: f.edited_at, edited_by: f.edited_by?.display_name ?? null },
  };
}

/** What chat's card for an artifact link shows to someone who can read it. */
export type FolioUnfurl = Pick<Folio, "id" | "kind" | "title" | "icon" | "path" | "private" | "excerpt" | "edited_at"> & { space: string | null; edited_by: string | null };

/**
 * The card for a g1t address embedded in a doc, as this reader may see
 * it: an issue or pull request with its state, a channel, a project, an
 * artifact. Anything they can't read is not found, exactly as one that
 * does not exist.
 */
async function embed(slug: string, address: string, viewer: User, origin: string): Promise<Result<unknown>> {
  let path: string;
  try {
    const url = new URL(address, origin);
    if (url.origin !== origin) return { ok: true, value: { kind: "link", title: url.hostname + url.pathname, subtitle: url.hostname, state: null, href: url.toString() } };
    path = url.pathname;
  } catch {
    return { ok: false, error: { code: "invalid", message: "That isn't an address." } };
  }
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const missing = { ok: false as const, error: { code: "not_found" as const, message: "Not found." } };
  // /<owner>/-/artifacts/<slug>-<id>
  if (parts[1] === "-" && parts[2] === "artifacts" && parts[3]) {
    if (parts[0]!.toLowerCase() !== slug) return missing;
    const id = folioIdFrom(parts[3]);
    if (!id) return missing;
    const found = await folios.folio(slug, viewer, id, { peek: true });
    if (!found.ok) return missing;
    const f = found.value;
    return { ok: true, value: { kind: "page", title: `${f.icon ? `${f.icon} ` : ""}${f.title || "Untitled"}`, subtitle: f.space?.name ?? "Private", state: null, href: f.path } };
  }
  // /<owner>/-/chat/<channel>
  if (parts[1] === "-" && parts[2] === "chat" && parts[3]) {
    return { ok: true, value: { kind: "channel", title: parts[3] === "dm" ? "A direct message" : `#${parts[3]}`, subtitle: "Chat", state: null, href: path } };
  }
  if (parts.length < 2 || parts[1] === "-") return missing;
  const repo = { namespace: parts[0]!, name: parts[1]! };
  // /<owner>/<repo>/issues/<n> and /pull/<n>
  const number = Number(parts[3]);
  if ((parts[2] === "issues" || parts[2] === "pull" || parts[2] === "pulls") && Number.isInteger(number) && number > 0) {
    if (parts[2] === "issues") {
      const found = await work.getIssue(repo, number, viewer);
      if (!found.ok) return missing;
      return { ok: true, value: { kind: "issue", title: `${found.value.issue.title} #${number}`, subtitle: `${repo.namespace}/${repo.name}`, state: found.value.issue.state, href: path } };
    }
    const found = await work.getPull(repo, number, viewer);
    if (!found.ok) return missing;
    const pull = found.value.pull as { title: string; status: string; mergedAt?: string | null };
    const state = pull.mergedAt ? "merged" : String(pull.status ?? "open");
    return { ok: true, value: { kind: "pull", title: `${pull.title} #${number}`, subtitle: `${repo.namespace}/${repo.name}`, state, href: path } };
  }
  const found = await repos.get(repo, viewer);
  if (!found.ok) return missing;
  return { ok: true, value: { kind: "project", title: `${repo.namespace}/${repo.name}`, subtitle: (found.value as { description?: string | null }).description ?? "Project", state: null, href: `/${repo.namespace}/${repo.name}` } };
}

/** The workspace's repositories the viewer can read, newest first: `owner/name` and its default branch. */
async function repositories(slug: string, viewer: User): Promise<Result<{ repo: string; default_branch: string; private: boolean }[]>> {
  const found = await repos.list(viewer, { namespace: slug });
  return {
    ok: true,
    value: found
      .filter((r) => !r.forkOf)
      .slice(0, 300)
      .map((r) => ({ repo: `${r.namespace}/${r.name}`.toLowerCase(), default_branch: r.defaultBranch, private: r.isPrivate })),
  };
}

/**
 * A citation for `path` in `repo`, as the viewer can read it: pinned to
 * the default branch's head commit, once the file or folder is there (a
 * glob is taken as written).
 */
async function cite(viewer: User, repo: string, rawPath: string): Promise<Result<{ repo: string; path: string; ref: string | null; kind: "file" | "folder" | "glob" }>> {
  const [namespace, name, ...rest] = repo.trim().toLowerCase().split("/");
  const missing = { ok: false as const, error: { code: "not_found" as const, message: "No such repository, or you can't read it." } };
  if (!namespace || !name || rest.length) return missing;
  const path = rawPath
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== ".")
    .join("/");
  if (!path || path.split("/").includes("..")) return { ok: false, error: { code: "invalid", message: "Name a file, a folder or a pattern in the repository." } };
  const where = { namespace, name };
  const root = await repos.tree(where, viewer, null, "");
  if (!root.ok) return missing;
  const head = root.value.head?.hash ?? null;
  if (/[*?]/.test(path)) return { ok: true, value: { repo: `${namespace}/${name}`, path, ref: head, kind: "glob" } };
  if (!head) return { ok: false, error: { code: "not_found", message: "That repository has no commits yet." } };
  const [blob, tree] = await Promise.all([repos.blob(where, viewer, head, path).catch(() => null), repos.tree(where, viewer, head, path).catch(() => null)]);
  if (blob?.ok) return { ok: true, value: { repo: `${namespace}/${name}`, path, ref: head, kind: "file" } };
  if (tree?.ok) return { ok: true, value: { repo: `${namespace}/${name}`, path, ref: head, kind: "folder" } };
  return { ok: false, error: { code: "not_found", message: `There is no ${path} on ${root.value.repo.defaultBranch}.` } };
}

/** Names and faces for member keys, as the workspace knows them. */
async function who(slug: string, viewer: User, keys: string[]): Promise<Result<unknown>> {
  const userIds = keys.filter((k) => k.startsWith("user:")).map((k) => k.slice(5));
  const agentIds = new Set(keys.filter((k) => k.startsWith("agent:")).map((k) => k.slice(6)));
  const [names, { people, agents }] = await Promise.all([userIds.length ? identity.usernames(userIds).catch(() => ({}) as Record<string, string>) : Promise.resolve({} as Record<string, string>), workspacePeople(slug, viewer)]);
  const out = keys.map((key) => {
    if (key.startsWith("agent:")) {
      const agent = agentIds.has(key.slice(6)) ? agents.find((a) => a.id === key.slice(6)) : undefined;
      return { key, kind: "agent", id: key.slice(6), name: agent?.handle ?? "agent", display_name: agent?.display_name ?? "Former agent", avatar: agent?.avatar ?? null, avatar_seed: agent?.avatar_seed ?? null, look: agent?.look ?? null };
    }
    const username = names[key.slice(5)]?.toLowerCase();
    const person = username ? people.find((p) => p.name === username) : undefined;
    return { key, kind: "user", id: key.slice(5), name: username ?? "ghost", display_name: person?.display_name ?? username ?? "Former member", avatar: person?.avatar ?? null, avatar_seed: null };
  });
  return { ok: true, value: out };
}
