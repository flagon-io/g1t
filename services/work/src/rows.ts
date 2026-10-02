import type {
  Attempt,
  AttemptRuntime,
  AttemptStatus,
  Intent,
  IntentStatus,
  SessionEntry,
  SessionEntryKind,
} from "@g1t/contracts";

export type IntentRow = {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  brief: string;
  checks: string;
  status: IntentStatus;
  author_id: string;
  author_name: string;
  created_at: number;
  attempt_count: number;
};

export type AttemptRow = {
  id: string;
  intent_id: string;
  repo_id: string;
  number: number;
  agent: string;
  runtime: AttemptRuntime;
  status: AttemptStatus;
  summary: string | null;
  fork_repo_id: string;
  fork_namespace: string;
  fork_name: string;
  head_commit: string | null;
  started_by_id: string;
  started_by_name: string;
  created_at: number;
  updated_at: number;
};

export type SessionRow = {
  attempt_id: string;
  seq: number;
  kind: SessionEntryKind;
  text: string;
  tool: string | null;
  commit: string | null;
  at: number;
};

export function toIntent(row: IntentRow): Intent {
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    title: row.title,
    brief: row.brief,
    checks: JSON.parse(row.checks),
    status: row.status,
    author: { id: row.author_id, username: row.author_name },
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
  };
}

export function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    intentId: row.intent_id,
    repoId: row.repo_id,
    number: row.number,
    agent: row.agent,
    runtime: row.runtime,
    status: row.status,
    summary: row.summary,
    fork: { namespace: row.fork_namespace, name: row.fork_name },
    headCommit: row.head_commit,
    startedBy: { id: row.started_by_id, username: row.started_by_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSessionEntry(row: SessionRow): SessionEntry {
  return {
    seq: row.seq,
    kind: row.kind,
    text: row.text,
    tool: row.tool,
    commit: row.commit,
    at: row.at,
  };
}
