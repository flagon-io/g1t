/**
 * A postmortem's starting point: the timeline written out from the
 * incident's own, the impact from its parts and times, and the follow-ups
 * as action items. Staff edit it before publishing. No Workers imports.
 */
import type { AdminIncident, FollowUp, PostmortemFields, TimelineEntry } from "@g1t/contracts";

import { duration } from "./incidents.ts";
import { IMPACT_WORD } from "./model.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "5 Oct 14:03 UTC". */
export function stamp(at: string): string {
  const d = new Date(at);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

/** Lines not worth a reader's time: acknowledgements, follow-up ticks, the postmortem itself. */
const SKIP = new Set(["acknowledged", "followup", "postmortem"]);

/** The internal timeline as a list, one line per entry, public updates marked. */
export function timelineText(entries: TimelineEntry[]): string {
  return entries
    .filter((e) => !SKIP.has(e.kind))
    .map((e) => `- ${stamp(e.at)}: ${e.kind === "update" ? "Status page: " : ""}${e.text.replace(/\s*\n+\s*/g, " ")}`)
    .join("\n");
}

export function postmortemDraft(
  incident: Pick<AdminIncident, "started_at" | "resolved_at" | "components" | "durations">,
  timeline: TimelineEntry[],
  followups: FollowUp[],
  names: Map<string, string>,
): PostmortemFields {
  const parts = incident.components
    .filter((c) => c.impact !== "operational")
    .map((c) => `${names.get(c.key) ?? c.key} (${IMPACT_WORD[c.impact].toLowerCase()})`);
  const lasted = incident.durations.to_resolve != null ? ` for ${duration(incident.durations.to_resolve)}` : "";
  const window = `from ${stamp(incident.started_at)}${incident.resolved_at ? ` to ${stamp(incident.resolved_at)}` : ""}`;
  return {
    summary: "",
    impact: `${parts.join(", ") || "No part"} affected${lasted}, ${window}.`,
    timeline: timelineText(timeline),
    root_cause: "",
    went_well: "",
    went_badly: "",
    action_items: followups.map((f) => `- ${f.title}`).join("\n"),
  };
}
