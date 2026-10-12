/**
 * Security advisories and private vulnerability reports as the pages read
 * them: what a form posts, checked, and how states and severities show.
 * Pure, so it is tested on its own (routes/repo/security-advisor*.tsx,
 * security-report*.tsx).
 */
import type { AdvisoryInput, AdvisorySeverity, AdvisoryState, ReportState } from "@g1t/contracts";

// The contracts' lists, as types only, so this file runs under `node --test`.
export const SEVERITIES: AdvisorySeverity[] = ["critical", "high", "medium", "low"];
export const ADVISORY_STATES: AdvisoryState[] = ["draft", "published", "withdrawn"];
export const REPORT_STATES: ReportState[] = ["new", "accepted", "declined"];

export const SEVERITY_LABEL: Record<AdvisorySeverity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const STATE_LABEL: Record<AdvisoryState, string> = { draft: "Draft", published: "Published", withdrawn: "Withdrawn" };

export const STATE_TONE: Record<AdvisoryState, "neutral" | "success" | "warn"> = { draft: "neutral", published: "success", withdrawn: "warn" };

export const REPORT_STATE_LABEL: Record<ReportState, string> = { new: "New", accepted: "Accepted", declined: "Declined" };

export const REPORT_STATE_TONE: Record<ReportState, "warn" | "success" | "neutral"> = { new: "warn", accepted: "success", declined: "neutral" };

export function parseSeverity(value: unknown): AdvisorySeverity | null {
  return SEVERITIES.find((severity) => severity === value) ?? null;
}

export function parseAdvisoryState(value: unknown): AdvisoryState | null {
  return ADVISORY_STATES.find((state) => state === value) ?? null;
}

export function parseReportState(value: unknown): ReportState | null {
  return REPORT_STATES.find((state) => state === value) ?? null;
}

const text = (form: FormData, key: string, max: number): string =>
  String(form.get(key) ?? "")
    .trim()
    .slice(0, max);

const optional = (form: FormData, key: string, max: number): string | null => text(form, key, max) || null;

/** The advisory a form posts, or what is wrong with it. */
export function advisoryFromForm(form: FormData): AdvisoryInput | string {
  const title = text(form, "title", 200);
  if (!title) return "Give the advisory a title.";
  const severity = parseSeverity(form.get("severity"));
  if (!severity) return "Choose a severity.";
  const scoreText = text(form, "cvssScore", 10);
  const cvssScore = scoreText ? Number(scoreText) : null;
  if (cvssScore != null && (!Number.isFinite(cvssScore) || cvssScore < 0 || cvssScore > 10)) return "A CVSS score is 0 to 10.";
  const cveId = optional(form, "cveId", 32);
  if (cveId && !/^CVE-\d{4}-\d{4,}$/i.test(cveId)) return "A CVE id looks like CVE-2026-12345.";
  return {
    title,
    description: text(form, "description", 20_000),
    severity,
    cvssVector: optional(form, "cvssVector", 200),
    cvssScore,
    cveId: cveId?.toUpperCase() ?? null,
    ecosystem: optional(form, "ecosystem", 50),
    package: optional(form, "package", 200),
    affectedVersions: optional(form, "affectedVersions", 200),
    patchedVersions: optional(form, "patchedVersions", 200),
    credits: text(form, "credits", 2000)
      .split(/[\n,]+/)
      .map((credit) => credit.trim().replace(/^@/, ""))
      .filter(Boolean)
      .slice(0, 20),
  };
}

export type ReportDraft = { title: string; description: string; severity: AdvisorySeverity | null; email: string | null };

/** The report a form posts, or what is wrong with it. Someone signed out gives an email. */
export function reportFromForm(form: FormData, signedIn: boolean): ReportDraft | string {
  const title = text(form, "title", 200);
  if (!title) return "Give the report a title: one line on what you found.";
  const description = text(form, "description", 20_000);
  if (!description) return "Describe the vulnerability: what is affected and how to reproduce it.";
  const email = optional(form, "email", 254);
  if (!signedIn && !(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return "Give an email address the maintainers can answer at, or sign in.";
  return { title, description, severity: parseSeverity(form.get("severity")), email: signedIn ? null : email };
}

/** "Published 3 days ago by ana", or what a draft or withdrawn advisory says. */
export function advisoryStanding(advisory: { state: AdvisoryState; createdBy: string; publishedAt?: string | null; withdrawnAt?: string | null }): {
  verb: string;
  at: string | null;
} {
  switch (advisory.state) {
    case "published":
      return { verb: "Published", at: advisory.publishedAt ?? null };
    case "withdrawn":
      return { verb: "Withdrawn", at: advisory.withdrawnAt ?? null };
    default:
      return { verb: `Drafted by ${advisory.createdBy}`, at: null };
  }
}
