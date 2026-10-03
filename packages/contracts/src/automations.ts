import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * Rules in a repository's `.g1t/automations/` that act when something
 * happens. Mirrors `crates/contracts/src/automations.rs`.
 */

export type StepResult = { step: string; ok: boolean; detail: string };

export type AutomationRun = {
  id: string;
  automationId: string;
  name: string;
  /** An event type, `schedule` or `manual`. */
  event: string;
  number: number | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  reason: string | null;
  steps: StepResult[];
  actor: string | null;
  startedAt: string;
};

export type Automation = {
  id: string;
  repo: string;
  path: string;
  name: string;
  /** What starts it, in words. */
  trigger: string;
  conditions: string[];
  steps: string[];
  enabled: boolean;
  /** Why its file cannot be used. */
  error: string | null;
  manual: boolean;
  lastRun: AutomationRun | null;
};

export interface AutomationsApi {
  list(repo: RepoPath, viewer: Viewer): Promise<Result<Automation[]>>;
  runs(repo: RepoPath, viewer: Viewer, automation?: string): Promise<Result<AutomationRun[]>>;
  run(actor: User, repo: RepoPath, id: string, number?: number): Promise<Result<AutomationRun>>;
  setEnabled(actor: User, repo: RepoPath, id: string, enabled: boolean): Promise<Result<Automation>>;
}
