import { data } from "react-router";

import type { DocEditTarget, DocMove, DocPageChange, DocRole, DocSpaceChange, NewDocPage, NewDocSpace, Result } from "@g1t/contracts";

import type { Route } from "./+types/api";
import { workspacePeople } from "../../../lib/chat.server";
import { docs, identity, repos, work } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";
import { pageIdOf } from "../../../lib/docs";

/**
 * What Docs pages ask for as they run, as JSON: page search for links and
 * the sidebar's search box, a page's history and one version, cards for
 * embedded g1t things; and everything they change: pages, spaces, members,
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
    if (q.has("search")) return docs.search(slug, viewer, { query: q.get("search") ?? "", space_id: q.get("space"), project: q.get("project"), limit: Number(q.get("limit")) || 10 });
    if (q.get("versions")) return docs.versions(slug, q.get("versions")!, viewer);
    if (q.get("version") && q.get("page")) return docs.version(slug, q.get("page")!, q.get("version")!, viewer);
    if (q.get("suggestions")) return docs.suggestions(slug, q.get("suggestions")!, viewer);
    if (q.get("threads")) return docs.threads(slug, q.get("threads")!, viewer);
    if (q.get("space")) return docs.space(slug, q.get("space")!, viewer);
    if (q.get("embed")) return embed(slug, q.get("embed")!, viewer, url.origin);
    if (q.has("templates")) return docs.templates(slug, viewer);
    // How member keys show (`user:<id>`, `agent:<id>`): comment authors, people on a page.
    if (q.get("who")) return who(slug, viewer, q.get("who")!.split(",").slice(0, 100));
    // A member's key (`user:<id>`) by username, for adding them to a space.
    if (q.get("person")) {
      const user = await identity.userByUsername(q.get("person")!.toLowerCase());
      return user ? { ok: true, value: `user:${user.id}` } : { ok: false, error: { code: "not_found", message: "No such person." } };
    }
    return docs.sidebar(slug, viewer);
  });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

type Sent = {
  intent?: string;
  page_id?: string;
  space_id?: string;
  suggestion_id?: string;
  version_id?: string;
  template_id?: string;
  member?: string;
  role?: DocRole | null;
  decision?: "accept" | "reject";
  on?: boolean;
  page?: NewDocPage;
  change?: DocPageChange;
  move?: DocMove;
  space?: NewDocSpace;
  space_change?: DocSpaceChange;
  name?: string;
  description?: string | null;
  target?: DocEditTarget;
};

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const sent = (await request.json().catch(() => ({}))) as Sent;
  const page = sent.page_id ?? "";
  const answer = await safely(async (): Promise<Result<unknown>> => {
    switch (sent.intent) {
      case "create_page":
        return docs.createPage(slug, viewer, sent.page ?? ({ space_id: sent.space_id ?? "" } as NewDocPage));
      case "update_page":
        return docs.updatePage(slug, page, viewer, sent.change ?? {});
      case "move_page":
        return docs.movePage(slug, page, viewer, sent.move ?? { parent_id: null });
      case "duplicate_page":
        return docs.duplicatePage(slug, page, viewer);
      case "archive_page":
        return docs.archivePage(slug, page, viewer);
      case "restore_page":
        return docs.restorePage(slug, page, viewer);
      case "delete_page":
        return docs.deletePage(slug, page, viewer);
      case "favorite":
        return docs.favorite(slug, page, viewer, !!sent.on);
      case "restore_version":
        return docs.restoreVersion(slug, page, sent.version_id ?? "", viewer);
      case "decide":
        return docs.decideSuggestion(slug, sent.suggestion_id ?? "", viewer, sent.decision === "accept" ? "accept" : "reject");
      case "accept_all":
        return docs.acceptAll(slug, page, viewer);
      case "save_template":
        return docs.saveTemplate(slug, viewer, { page_id: page, name: sent.name ?? "", description: sent.description ?? null });
      case "delete_template":
        return docs.deleteTemplate(slug, sent.template_id ?? "", viewer);
      case "create_space":
        return docs.createSpace(slug, viewer, sent.space ?? ({ name: "", kind: "workspace" } as NewDocSpace));
      case "update_space":
        return docs.updateSpace(slug, sent.space_id ?? "", viewer, sent.space_change ?? {});
      case "set_member":
        return docs.setSpaceMember(slug, sent.space_id ?? "", viewer, sent.member ?? "", sent.role ?? null);
      default:
        return { ok: false, error: { code: "invalid", message: "Unknown request." } };
    }
  });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

async function safely<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    console.error("docs api:", error);
    return { ok: false, error: { code: "conflict", message: "Docs didn't answer. Try again in a moment." } };
  }
}

/**
 * The card for a g1t address embedded in a page, as this reader may see
 * it: an issue or pull request with its state, a channel, a project, a
 * page. Anything they can't read is not found, exactly as one that does
 * not exist.
 */
async function embed(slug: string, address: string, viewer: Parameters<typeof docs.page>[2], origin: string): Promise<Result<unknown>> {
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
  // /<owner>/-/docs/<space>/<page>
  if (parts[1] === "-" && parts[2] === "docs" && parts[4]) {
    if (parts[0]!.toLowerCase() !== slug) return missing;
    const id = pageIdOf(parts[4]);
    if (!id) return missing;
    const found = await docs.page(slug, id, viewer);
    if (!found.ok) return missing;
    return { ok: true, value: { kind: "page", title: `${found.value.page.icon ? `${found.value.page.icon} ` : ""}${found.value.page.title || "Untitled"}`, subtitle: found.value.space.name, state: null, href: found.value.page.path } };
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

/** Names and faces for member keys, as the workspace knows them. */
async function who(slug: string, viewer: Parameters<typeof docs.page>[2], keys: string[]): Promise<Result<unknown>> {
  const userIds = keys.filter((k) => k.startsWith("user:")).map((k) => k.slice(5));
  const agentIds = new Set(keys.filter((k) => k.startsWith("agent:")).map((k) => k.slice(6)));
  const [names, { people, agents }] = await Promise.all([userIds.length ? identity.usernames(userIds).catch(() => ({}) as Record<string, string>) : Promise.resolve({} as Record<string, string>), workspacePeople(slug, viewer)]);
  const out = keys.map((key) => {
    if (key.startsWith("agent:")) {
      const agent = agentIds.has(key.slice(6)) ? agents.find((a) => a.id === key.slice(6)) : undefined;
      return { key, kind: "agent", id: key.slice(6), name: agent?.handle ?? "agent", display_name: agent?.display_name ?? "Former agent", avatar: agent?.avatar ?? null, avatar_seed: agent?.avatar_seed ?? null };
    }
    const username = names[key.slice(5)]?.toLowerCase();
    const person = username ? people.find((p) => p.name === username) : undefined;
    return { key, kind: "user", id: key.slice(5), name: username ?? "ghost", display_name: person?.display_name ?? username ?? "Former member", avatar: person?.avatar ?? null, avatar_seed: null };
  });
  return { ok: true, value: out };
}

