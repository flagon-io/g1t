import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSignedIn } from "./session";
import type { ApiWorkItem } from "./work";

/**
 * Code, through the REST API (docs.g1t.sh/reference/api/). The API
 * answers in snake_case, so these are its shapes, not the camelCase ones
 * in @g1t/contracts that the services use among themselves. Only the
 * fields the app shows are named.
 */

/** `agent` only on what g1t's own agents wrote before they were retired; shown with an Agent badge. */
export type ApiUser = { id: string; username: string; display_username?: string; kind?: "user" | "workspace" | "agent" | "system" };

export type ApiRepo = {
  id: string;
  namespace: string;
  name: string;
  is_private: boolean;
  default_branch: string;
  created_at: string;
  archived_at?: string | null;
};

export type CheckStatus = "queued" | "running" | "passed" | "failed" | "errored" | null;

export type ApiPull = {
  id: string;
  number: number;
  /** The work item it is for, by number in the workspace. */
  item: number | null;
  title: string;
  body: string | null;
  /** The coding agent it was made with (`claude-code`, `codex`), from the session recorded on it; null when none was. */
  agent: string | null;
  status: "draft" | "open" | "merged" | "closed";
  branch: string | null;
  base: string;
  check_status: CheckStatus;
  files: { path: string; additions: number; deletions: number }[];
  reviewers: string[];
  labels: string[];
  author: ApiUser;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
};

export type ApiComment = {
  id: string;
  kind: "comment" | "event";
  author: ApiUser;
  body: string;
  path: string | null;
  line: number | null;
  verdict: string | null;
  created_at: string;
};

export type ApiChanges = {
  base: string;
  head: string;
  truncated: boolean;
  files: {
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    binary: boolean;
    /** Past what one answer reads: listed without its lines or counts. */
    omitted?: boolean;
    hunks?: { lines: { kind: "context" | "add" | "delete"; old: number | null; new: number | null; text: string }[] }[];
  }[];
};

const repoPath = (owner: string, name: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

/** Repositories you can see, newest first (at most 50), in the workspace chosen. */
export function useRepos(search: string) {
  const { client, workspace } = useSignedIn();
  return useQuery({
    queryKey: ["code", "repos", search],
    queryFn: () => client.api<ApiRepo[]>(`/repos${search ? `?q=${encodeURIComponent(search)}` : ""}`),
    select: (repos) => (workspace ? repos.filter((repo) => repo.namespace.toLowerCase() === workspace.slug.toLowerCase()) : repos),
  });
}

/** A workspace's project as the API answers; only what descriptions need. */
type ApiProject = { repository: string | null; primary: boolean; description: string | null };

/**
 * The descriptions of a workspace's repositories, by lowercase
 * `owner/name`. A repository has none of its own: its project's is shown.
 */
export function useDescriptions(workspace: string | null | undefined) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["code", "descriptions", workspace?.toLowerCase()],
    enabled: Boolean(workspace),
    queryFn: () => client.api<ApiProject[]>(`/workspaces/${encodeURIComponent(workspace!)}/projects`),
    select: (projects) =>
      Object.fromEntries(
        projects
          .filter((project) => project.primary && project.repository && project.description)
          .map((project) => [project.repository!.toLowerCase(), project.description!]),
      ) as Record<string, string>,
  });
}

export function usePulls(owner: string, name: string, state: "open" | "closed" | "all") {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["code", "pulls", owner, name, state],
    queryFn: () => client.api<ApiPull[]>(`${repoPath(owner, name)}/pulls?state=${state}`),
  });
}

export function usePull(owner: string, name: string, number: number) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["code", "pull", owner, name, number],
    queryFn: () =>
      client.api<{ pull: ApiPull; item: ApiWorkItem | null; comments: ApiComment[] }>(`${repoPath(owner, name)}/pulls/${number}`),
  });
}

export function usePullChanges(owner: string, name: string, number: number, enabled: boolean) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["code", "pull-changes", owner, name, number],
    queryFn: () => client.api<ApiChanges>(`${repoPath(owner, name)}/pulls/${number}/changes`),
    enabled,
  });
}

/** Reviews a pull request (`POST /repos/{owner}/{name}/pulls/{number}/reviews`). */
export function useReview(owner: string, name: string, number: number) {
  const { client } = useSignedIn();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (review: { verdict: "approve" | "request_changes"; body: string }) =>
      client.api<ApiComment>(`${repoPath(owner, name)}/pulls/${number}/reviews`, { method: "POST", body: JSON.stringify(review) }),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["code", "pull", owner, name, number] }),
  });
}
