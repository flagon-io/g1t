import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { boardOf } from "./board";
import type { Client } from "./client";
import type { ApiComment, ApiPull, ApiUser, CheckStatus } from "./code";
import type { RefContext, RefTarget } from "./links";
import { useSignedIn } from "./session";
import { type ApiSessionDetail, type ApiWorkspaceSessions, ENTRY_PAGE, type SessionsFilter, isLive, sessionsQuery } from "./sessions";

/**
 * Work, through the REST API (docs.g1t.sh/reference/api/work-items/): a
 * workspace's work items, each linked to the repositories it concerns.
 * As in lib/code.ts these are the API's snake_case shapes, and only the
 * fields the app shows are named.
 */

export type LinkRole = "origin" | "target" | "touched";
export type CloseReason = "completed" | "not_planned";

/** A repository a work item is linked to. */
export type ApiItemRepo = {
  repo_id: string;
  /** `owner/name`. */
  path: string;
  role: LinkRole;
  /** For an item that was an issue of this repository: its number there. */
  legacy_number: number | null;
  /** What closes it landed here. */
  landed: boolean;
};

export type ApiWorkItem = {
  id: string;
  workspace: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  reason: CloseReason | null;
  author: ApiUser;
  assignees: string[];
  milestone?: { number: number; title: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comment_count: number;
  pull_count: number;
  repos: ApiItemRepo[];
};

/** A pull request for a work item, in the repository it is in. */
export type ApiWorkPull = {
  repo: string;
  number: number;
  title: string;
  status: "draft" | "open" | "merged" | "closed";
  check_status: CheckStatus;
};

export type ApiWorkRepo = ApiItemRepo & { pulls: ApiWorkPull[] };

/** A repository the work may belong in, and why g1t thinks so. */
export type ApiSuggestedTarget = { repo_id: string; path: string; why: string };

/** `GET …/work/{number}/work`: the item with its repositories, their pull requests, and what is missing. */
export type ApiWorkContext = {
  item: ApiWorkItem;
  repos: ApiWorkRepo[];
  missing: string[];
  suggested_targets: ApiSuggestedTarget[];
};

export type ApiLabel = { name: string; color: string; description: string };
export type ApiMilestone = { number: number; title: string; state: "open" | "closed"; due_on: string | null };

/** What the list shows; each field is one of the API's list filters. */
export type WorkFilter = {
  state: "open" | "closed" | "all";
  label?: string;
  milestone?: number;
  assignee?: string;
  /** A repository of the workspace, by name. */
  repo?: string;
  role?: LinkRole;
};

export const PAGE = 30;

const workPath = (workspace: string) => `/workspaces/${encodeURIComponent(workspace)}/work`;
const itemPath = (workspace: string, number: number) => `${workPath(workspace)}/${number}`;

/** The query string for a filter and a page. */
export function filterQuery(filter: WorkFilter, page: number): string {
  const params = new URLSearchParams({ state: filter.state, page: String(page), per_page: String(PAGE) });
  if (filter.label) params.set("label", filter.label);
  if (filter.milestone) params.set("milestone", String(filter.milestone));
  if (filter.assignee) params.set("assignee", filter.assignee);
  if (filter.repo) params.set("repo", filter.repo);
  if (filter.repo && filter.role) params.set("role", filter.role);
  return params.toString();
}

/**
 * A workspace's work items, newest first, a page at a time. A page that
 * brings nothing new ends the list, so an answer that ignores paging is
 * shown once.
 */
export function useWorkItems(workspace: string | undefined, filter: WorkFilter) {
  const { client } = useSignedIn();
  const query = useInfiniteQuery({
    queryKey: ["work", "items", workspace?.toLowerCase(), filter],
    enabled: Boolean(workspace),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => client.api<ApiWorkItem[]>(`${workPath(workspace!)}?${filterQuery(filter, pageParam)}`),
    getNextPageParam: (last, pages, lastPage) => {
      if (last.length < PAGE) return undefined;
      const seen = new Set(pages.slice(0, -1).flatMap((page) => page.map((item) => item.id)));
      return last.some((item) => !seen.has(item.id)) ? lastPage + 1 : undefined;
    },
  });
  const items = (() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flat().filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  })();
  return { ...query, items };
}

export function useWorkItem(workspace: string, number: number) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["work", "item", workspace.toLowerCase(), number],
    queryFn: () => client.api<{ item: ApiWorkItem; comments: ApiComment[] }>(itemPath(workspace, number)),
  });
}

/** The item's repositories with their pull requests, what has not landed, and suggested targets. */
export function useWorkContext(workspace: string, number: number) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["work", "context", workspace.toLowerCase(), number],
    queryFn: () => client.api<ApiWorkContext>(`${itemPath(workspace, number)}/work`),
    retry: false,
  });
}

export function useLabels(workspace: string | undefined) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["work", "labels", workspace?.toLowerCase()],
    enabled: Boolean(workspace),
    queryFn: () => client.api<ApiLabel[]>(`/workspaces/${encodeURIComponent(workspace!)}/labels`),
    staleTime: 5 * 60_000,
  });
}

export function useMilestones(workspace: string | undefined) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["work", "milestones", workspace?.toLowerCase()],
    enabled: Boolean(workspace),
    queryFn: () => client.api<ApiMilestone[]>(`/workspaces/${encodeURIComponent(workspace!)}/milestones?state=open`),
    staleTime: 5 * 60_000,
  });
}

/** Everything that changes an item: comment, close, reopen, link and unlink a repository. */
export function useItemActions(workspace: string, number: number) {
  const { client } = useSignedIn();
  const queries = useQueryClient();
  const path = itemPath(workspace, number);
  const refresh = () =>
    Promise.all([
      queries.invalidateQueries({ queryKey: ["work", "item", workspace.toLowerCase(), number] }),
      queries.invalidateQueries({ queryKey: ["work", "context", workspace.toLowerCase(), number] }),
      queries.invalidateQueries({ queryKey: ["work", "items", workspace.toLowerCase()] }),
    ]);
  const post = <T>(suffix: string, body: unknown, method = "POST") => client.api<T>(`${path}${suffix}`, { method, body: JSON.stringify(body) });
  return {
    comment: useMutation({ mutationFn: (body: string) => post<ApiComment>("/comments", { body }), onSuccess: refresh }),
    close: useMutation({ mutationFn: (reason: CloseReason) => post<ApiWorkItem>("/close", { reason }), onSuccess: refresh }),
    reopen: useMutation({ mutationFn: () => post<ApiWorkItem>("/reopen", {}), onSuccess: refresh }),
    link: useMutation({
      mutationFn: ({ repo, role = "target" }: { repo: string; role?: LinkRole }) => post<ApiWorkItem>("/links", { repo, role }),
      onSuccess: refresh,
    }),
    unlink: useMutation({
      mutationFn: (repo: string) => client.api<ApiWorkItem>(`${path}/links?repo=${encodeURIComponent(repo)}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}

export type NewWorkItem = {
  title: string;
  body: string;
  labels: string[];
  /** Repositories where the work is meant to land, `owner/name`. */
  targets: string[];
  /** The repository it is filed from, `owner/name`, when started from one. */
  repo?: string;
};

export function useOpenWorkItem(workspace: string) {
  const { client } = useSignedIn();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: NewWorkItem) => client.api<ApiWorkItem>(workPath(workspace), { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["work", "items", workspace.toLowerCase()] }),
  });
}

/**
 * What `#N` names in a context, by g1t's one set of rules
 * (crates/contracts/src/work/refs.rs).
 */
export function useRefTarget(context: RefContext | null, number: number) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["work", "ref", context, number],
    enabled: Boolean(context),
    retry: false,
    queryFn: () => client.api<RefTarget>(`${refPath(context!)}/refs/${number}`),
  });
}

function refPath(context: RefContext): string {
  if ("repo" in context) return `/repos/${context.repo.split("/").map(encodeURIComponent).join("/")}`;
  return `/workspaces/${encodeURIComponent(context.workspace)}`;
}

const sessionsPath = (workspace: string) => `/workspaces/${encodeURIComponent(workspace)}/sessions`;

/** How often Sessions and a live session are read again while on screen. */
export const POLL_MS = 15_000;

/**
 * A workspace's sessions, most recently heard from first. With `poll`
 * (the screen is in view) they are read again every 15 s while one is live.
 */
export function useWorkspaceSessions(workspace: string | undefined, filter: SessionsFilter, poll = false) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["work", "sessions", workspace?.toLowerCase(), filter],
    enabled: Boolean(workspace),
    queryFn: () => client.api<ApiWorkspaceSessions>(`${sessionsPath(workspace!)}?${sessionsQuery(filter)}`),
    refetchInterval: (query) => (poll && query.state.data?.sessions.some(isLive) ? POLL_MS : false),
  });
}

/**
 * One session and what it recorded, 500 steps at a time. With `poll` it
 * is read again every 15 s while it is live.
 */
export function useWorkspaceSession(workspace: string, id: string, poll = false) {
  const { client } = useSignedIn();
  const query = useInfiniteQuery({
    queryKey: ["work", "session", workspace.toLowerCase(), id],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      client.api<ApiSessionDetail>(`${sessionsPath(workspace)}/${encodeURIComponent(id)}${pageParam === undefined ? "" : `?after=${pageParam}`}`),
    getNextPageParam: (last) => (last.entries.length >= ENTRY_PAGE ? last.entries[last.entries.length - 1].seq : undefined),
    refetchInterval: (query) => {
      const first = query.state.data?.pages[0];
      return poll && first && isLive(first.session) ? POLL_MS : false;
    },
  });
  const pages = query.data?.pages ?? [];
  const detail = pages.length ? pages[pages.length - 1] : undefined;
  const entries = (() => {
    const seen = new Set<number>();
    return pages.flatMap((page) => page.entries).filter((entry) => (seen.has(entry.seq) ? false : (seen.add(entry.seq), true)));
  })();
  return { ...query, detail, entries };
}

/** Every page of a list of items, up to `pages` of them. */
async function allItems(client: Client, workspace: string, state: "open" | "closed", pages: number): Promise<ApiWorkItem[]> {
  const items: ApiWorkItem[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const batch = await client.api<ApiWorkItem[]>(`${workPath(workspace)}?${filterQuery({ state }, page)}`);
    const fresh = batch.filter((item) => !seen.has(item.id));
    fresh.forEach((item) => seen.add(item.id));
    items.push(...fresh);
    if (batch.length < PAGE || fresh.length === 0) break;
  }
  return items;
}

/** The repositories whose open pull requests the board reads, at most. */
const BOARD_REPOS = 20;

/**
 * Work's board (lib/board.ts): the open items, those closed lately, the
 * live sessions, and each repository's open pull requests. With `poll`,
 * the sessions are read again every 15 s while one is live.
 */
export function useBoard(workspace: string | undefined, poll = false) {
  const { client } = useSignedIn();
  const key = workspace?.toLowerCase();
  const open = useQuery({ queryKey: ["work", "board", key, "open"], enabled: Boolean(workspace), queryFn: () => allItems(client, workspace!, "open", 10) });
  const closed = useQuery({
    queryKey: ["work", "board", key, "closed"],
    enabled: Boolean(workspace),
    queryFn: () => allItems(client, workspace!, "closed", 3),
  });
  const sessions = useWorkspaceSessions(workspace, { state: "live" }, poll);
  const repos = (sessions.data?.repos ?? []).slice(0, BOARD_REPOS);
  const pulls = useQueries({
    queries: repos.map((repo) => {
      const [owner, name] = repo.path.split("/", 2);
      return {
        queryKey: ["code", "pulls", owner, name, "open"],
        queryFn: () => client.api<ApiPull[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open`),
        retry: false,
      };
    }),
  });
  const read = pulls.flatMap((one) => one.data ?? []);
  const board = boardOf([...(open.data ?? []), ...(closed.data ?? [])], { pulls: read, sessions: sessions.data?.sessions ?? [] });
  return {
    board,
    isPending: open.isPending || closed.isPending,
    error: open.error ?? closed.error,
    isRefetching: open.isRefetching || closed.isRefetching || sessions.isRefetching,
    refetch: () => Promise.all([open.refetch(), closed.refetch(), sessions.refetch(), ...pulls.map((one) => one.refetch())]),
  };
}
