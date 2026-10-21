import { useLocation, useMatches } from "react-router";

import { NavTab, NavTabs } from "./ui/nav-tabs";
import { Hint } from "./ui/hint";
import { workPath } from "../lib/work-items";

/** Work's views, as its tabs list them: the path under `-/work` ("" is the Plan), and what each is. */
export const WORK_TABS = [
  { path: "", label: "Plan", about: "What the workspace is on now, what comes next, and what can wait" },
  { path: "board", label: "Board", about: "Work items as they move" },
  { path: "triage", label: "Triage", about: "New work items nobody has placed yet" },
  { path: "all", label: "All items", about: "Every work item, with filters" },
  { path: "milestones", label: "Milestones", about: "Goals with a due date" },
] as const;

/**
 * Which of Work's tabs `pathname` is (its path under `-/work`, "" for the
 * Plan), or null for Work's other pages: one item, one milestone, a new
 * item, labels. Sessions are Chat's.
 */
export function workTab(pathname: string, workspace: string): string | null {
  const base = workPath(workspace);
  const path = pathname.replace(/\.data$/, "").replace(/\/+$/, "");
  if (path.toLowerCase() === base) return "";
  if (!path.toLowerCase().startsWith(`${base}/`)) return null;
  const rest = path.slice(base.length + 1);
  return WORK_TABS.some((tab) => tab.path === rest) ? rest : null;
}

/** How many wait in Triage, from whichever page's loader read the plan (`triageTotal`): none shown when no page did. */
function useTriageTotal(): number | undefined {
  for (const match of useMatches()) {
    const data = match.loaderData as { triageTotal?: unknown } | undefined;
    if (data && typeof data.triageTotal === "number") return data.triageTotal;
  }
  return undefined;
}

/**
 * Work's tabs, over each of its views: Plan, Board, Triage (with how many
 * wait there), All items, Milestones and Sessions.
 */
export function WorkTabs({ workspace }: { workspace: string }) {
  const { pathname } = useLocation();
  const current = workTab(pathname, workspace);
  const triage = useTriageTotal();
  return (
    <div className="mb-6 border-b border-line pb-3">
      <NavTabs label="Work" variant="pill">
        {WORK_TABS.map((tab) => (
          <Hint key={tab.path} label={tab.about}>
            <NavTab variant="pill" to={workPath(workspace, tab.path)} current={current === tab.path} count={tab.path === "triage" ? triage : undefined}>
              {tab.label}
            </NavTab>
          </Hint>
        ))}
      </NavTabs>
    </div>
  );
}
