/**
 * g1t's status lives at status.g1t.sh (apps/status), a Worker of its own
 * that stays up when the site does not. The site only links to it, and
 * reads its JSON for the dot in the account menu and the footer.
 */
import type { StatusOverallState, StatusReport } from "@g1t/contracts";

export type { StatusOverallState as OverallState, StatusReport };

/** The status page. */
export const STATUS_URL = "https://status.g1t.sh";
/** Its report, as JSON, readable from any origin. */
export const STATUS_JSON_URL = `${STATUS_URL}/status.json`;

/** Two or three words for the whole, when the report has none. */
export const STATUS_WORDS: Record<StatusOverallState, string> = {
  up: "All systems normal",
  degraded: "Partial outage",
  down: "Major outage",
  maintenance: "Under maintenance",
  unknown: "Status unknown",
};

/** The short line for the whole: the report's own title, else words for its state. */
export function statusTitle(report: Pick<StatusReport, "overall"> | null | undefined): string | null {
  if (!report?.overall) return null;
  return report.overall.title || STATUS_WORDS[report.overall.state] || null;
}

/** The dot's colour for a state, as a Tailwind background class. */
export function dotClass(state: string | null | undefined): string {
  switch (state) {
    case "up":
      return "bg-success";
    case "degraded":
      return "bg-warn";
    case "down":
      return "bg-danger";
    case "maintenance":
      return "bg-info";
    default:
      return "bg-faint";
  }
}
