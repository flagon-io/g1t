/**
 * Which routine event a system event is, and what makes it the same thing
 * twice. Pure, so it is tested on its own (triggers.ts runs routines).
 */
import type { G1tEvent, RoutineEvent } from "@g1t/contracts";

export type Happened = { kind: RoutineEvent; repoId: string; key: string; number: number | null; data: Record<string, unknown> };

/** The routine event an event is, if any, and what makes it the same thing twice. */
export function happened(event: Pick<G1tEvent, "type" | "repoId" | "data">): Happened | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const repoId = (typeof data.repoId === "string" ? data.repoId : null) ?? event.repoId;
  if (!repoId) return null;
  const number = typeof data.number === "number" ? data.number : null;
  switch (event.type) {
    case "pull.opened":
    case "pull.ready":
      return number == null ? null : { kind: "pull_ready", repoId, key: `pull_ready:${repoId}:${number}`, number, data };
    case "pull.merged":
      return number == null ? null : { kind: "pull_merged", repoId, key: `pull_merged:${repoId}:${number}`, number, data };
    case "checks.completed": {
      const status = data.status;
      if (number == null || (status !== "failed" && status !== "errored")) return null;
      return { kind: "checks_failed", repoId, key: `checks_failed:${repoId}:${number}:${String(data.commit ?? "")}`, number, data };
    }
    case "issue.opened":
      return number == null ? null : { kind: "issue_opened", repoId, key: `issue_opened:${repoId}:${number}`, number, data };
    case "deployment.failed":
      return { kind: "deploy_failed", repoId, key: `deploy_failed:${String(data.deploymentId ?? "")}`, number, data };
    default:
      return null;
  }
}

/** Whether a routine follows this repository: all of them, or it is on its list. */
export function follows(repos: string[], full: string): boolean {
  return !repos.length || repos.includes(full.toLowerCase());
}

