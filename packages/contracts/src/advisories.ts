import type { ServiceBinding } from "./clients";
import type { User, Viewer } from "./identity";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/**
 * Repository security advisories and private vulnerability reporting, the
 * Reporting half of a repository's Security page. Mirrors
 * `crates/contracts/src/advisories.rs`.
 *
 * An advisory is a repository's own account of a vulnerability in what it
 * ships: a draft until its maintainers publish it, visible to anyone who can
 * see the repository once they do, and withdrawable. A vulnerability report
 * is how someone outside tells the maintainers privately, when the
 * repository has private vulnerability reporting on; accepting one makes a
 * draft advisory from it.
 */

export type AdvisorySeverity = "critical" | "high" | "medium" | "low";

export const ADVISORY_SEVERITIES: AdvisorySeverity[] = ["critical", "high", "medium", "low"];

export type AdvisoryState = "draft" | "published" | "withdrawn";

export const ADVISORY_STATES: AdvisoryState[] = ["draft", "published", "withdrawn"];

export type ReportState = "new" | "accepted" | "declined";

export const REPORT_STATES: ReportState[] = ["new", "accepted", "declined"];

/** The longest title, description and version range kept. */
export const MAX_ADVISORY_TITLE = 200;
export const MAX_ADVISORY_DESCRIPTION = 20_000;
export const MAX_ADVISORY_RANGE = 200;
export const MAX_ADVISORY_CREDITS = 20;

export type Advisory = {
  /** `adv_…`. */
  id: string;
  /** `G1TSA-2026-abcd-efgh`: what people quote. */
  g1tsaId: string;
  repoId: string;
  /** `owner/name`. */
  repo: string;
  title: string;
  /** Markdown. */
  description: string;
  severity: AdvisorySeverity;
  cvssVector?: string | null;
  cvssScore?: number | null;
  cveId?: string | null;
  ecosystem?: string | null;
  package?: string | null;
  affectedVersions?: string | null;
  patchedVersions?: string | null;
  state: AdvisoryState;
  credits: string[];
  /** The report it was made from, if any. */
  reportId?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
  withdrawnAt?: string | null;
};

/** What a maintainer writes when creating or changing an advisory. */
export type AdvisoryInput = {
  title: string;
  description: string;
  severity: AdvisorySeverity;
  cvssVector?: string | null;
  cvssScore?: number | null;
  cveId?: string | null;
  ecosystem?: string | null;
  package?: string | null;
  affectedVersions?: string | null;
  patchedVersions?: string | null;
  credits?: string[];
};

export type VulnerabilityReport = {
  /** `vrp_…`. */
  id: string;
  repoId: string;
  repo: string;
  /** A username when signed in, else the address given. */
  reporter?: string | null;
  reporterEmail?: string | null;
  title: string;
  description: string;
  severity?: AdvisorySeverity | null;
  state: ReportState;
  /** The draft advisory an accepted report became. */
  advisoryId?: string | null;
  createdAt: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
};

export type ReviewedReport = { report: VulnerabilityReport; advisory?: Advisory | null };

export interface AdvisoriesApi {
  /** Published ones for anyone who can see the repository; every state for those who see findings. */
  list(repo: RepoPath, viewer: Viewer, state?: AdvisoryState | null): Promise<Result<Advisory[]>>;
  /** By `adv_…` or `G1TSA-…` id. */
  get(repo: RepoPath, id: string, viewer: Viewer): Promise<Result<Advisory>>;
  /** A draft. Admin, or a security manager of the workspace. */
  create(actor: User, repo: RepoPath, advisory: AdvisoryInput): Promise<Result<Advisory>>;
  update(actor: User, repo: RepoPath, id: string, advisory: AdvisoryInput): Promise<Result<Advisory>>;
  /** `published` publishes a draft or brings a withdrawn one back; `withdrawn` withdraws. */
  setState(actor: User, repo: RepoPath, id: string, state: "published" | "withdrawn"): Promise<Result<Advisory>>;
  /** Tells the maintainers privately. Someone signed out gives an `email`. */
  report(
    viewer: Viewer,
    repo: RepoPath,
    report: { title: string; description: string; severity?: AdvisorySeverity | null; email?: string | null },
  ): Promise<Result<VulnerabilityReport>>;
  /** The repository's reports, newest first. Those who see findings. */
  reports(repo: RepoPath, viewer: Viewer, state?: ReportState | null): Promise<Result<VulnerabilityReport[]>>;
  /** `accept` makes a draft advisory from the report; `decline` closes it. */
  review(actor: User, repo: RepoPath, id: string, decision: "accept" | "decline", note: string): Promise<Result<ReviewedReport>>;
}

/** Advisories and reports: methods of the security service. */
export function advisoriesClient(service: ServiceBinding): AdvisoriesApi {
  const call = async <T>(method: string, args: object): Promise<T> => {
    const response = await service.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    list: (repo, viewer, state = null) => call("list_advisories", { repo, viewer, state }),
    get: (repo, id, viewer) => call("get_advisory", { repo, id, viewer }),
    create: (actor, repo, advisory) => call("create_advisory", { actor, repo, advisory }),
    update: (actor, repo, id, advisory) => call("update_advisory", { actor, repo, id, advisory }),
    setState: (actor, repo, id, state) => call("set_advisory_state", { actor, repo, id, state }),
    report: (viewer, repo, report) =>
      call("report_vulnerability", {
        viewer,
        repo,
        title: report.title,
        description: report.description,
        severity: report.severity ?? null,
        email: report.email ?? null,
      }),
    reports: (repo, viewer, state = null) => call("list_vulnerability_reports", { repo, viewer, state }),
    review: (actor, repo, id, decision, note) => call("review_vulnerability_report", { actor, repo, id, decision, note }),
  };
}
