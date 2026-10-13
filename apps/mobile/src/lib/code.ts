import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSignedIn } from "./session";

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
  description: string | null;
  is_private: boolean;
  default_branch: string;
  created_at: string;
  archived_at?: string | null;
};

export type ApiIssue = {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  reason: "completed" | "not_planned" | null;
  author: ApiUser;
  created_at: string;
  updated_at: string;
  comment_count: number;
  pull_count: number;
};

export type CheckStatus = "queued" | "running" | "passed" | "failed" | "errored" | null;

export type ApiPull = {
  id: string;
  number: number;
  issue: number | null;
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

export function useRepo(owner: string, name: string) {
  const { client } = useSignedIn();
  return useQuery({ queryKey: ["code", "repo", owner, name], queryFn: () => client.api<ApiRepo>(repoPath(owner, name)) });
}

export function usePulls(owner: string, name: string, state: "open" | "closed" | "all") {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["code", "pulls", owner, name, state],
    queryFn: () => client.api<ApiPull[]>(`${repoPath(owner, name)}/pulls?state=${state}`),
  });
}

export function useIssues(owner: string, name: string, state: "open" | "closed" | "all") {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["code", "issues", owner, name, state],
    queryFn: () => client.api<ApiIssue[]>(`${repoPath(owner, name)}/issues?state=${state}`),
  });
}

export function usePull(owner: string, name: string, number: number) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["code", "pull", owner, name, number],
    queryFn: () =>
      client.api<{ pull: ApiPull; issue: ApiIssue | null; comments: ApiComment[] }>(`${repoPath(owner, name)}/pulls/${number}`),
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

export function useIssue(owner: string, name: string, number: number) {
  const { client } = useSignedIn();
  return useQuery({
    queryKey: ["code", "issue", owner, name, number],
    queryFn: () =>
      client.api<{ issue: ApiIssue; pulls: ApiPull[]; comments: ApiComment[] }>(`${repoPath(owner, name)}/issues/${number}`),
  });
}

/** Comments on an issue (`POST /repos/{owner}/{name}/issues/{number}/comments`). */
export function useComment(owner: string, name: string, number: number) {
  const { client } = useSignedIn();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      client.api<ApiComment>(`${repoPath(owner, name)}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["code", "issue", owner, name, number] }),
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
