/**
 * A project's pages and the tabs within them, in one place: the sidebar
 * lists the pages, and a page with more than one view shows them as tabs
 * across its top, the way GitHub and Vercel do. Soon tabs come from the
 * roadmap and open its page for them, under the same tabs.
 */
import { type RoadmapItem, roadmapIn } from "./roadmap";

export type Tab = {
  label: string;
  /** Under the project, without a leading slash; "" is its overview. */
  path: string;
  /** Other paths under which this tab is the current one. */
  also?: string[];
  soon?: boolean;
  about?: string;
  /** Members only. */
  members?: boolean;
};

export type Section = {
  key: RoadmapItem["section"] | "Workflows" | "Settings";
  tabs: Tab[];
};

function soon(section: RoadmapItem["section"]): Tab[] {
  return roadmapIn(section).map((item) => ({ label: item.title, path: `soon/${item.key}`, soon: true, about: item.summary }));
}

export const SECTIONS: Section[] = [
  {
    key: "Code",
    tabs: [
      { label: "Files", path: "code", also: ["tree", "blob"] },
      { label: "Commits", path: "commits", also: ["commit"] },
      ...soon("Code"),
    ],
  },
  {
    key: "Issues",
    tabs: [
      { label: "Issues", path: "issues" },
      { label: "Outcomes", path: "plans", members: true },
      ...soon("Issues"),
    ],
  },
  {
    key: "Agents",
    tabs: [
      { label: "At work", path: "agents" },
      { label: "Sessions", path: "sessions" },
      { label: "Memory", path: "memory", members: true },
      ...soon("Agents"),
    ],
  },
  {
    key: "Deployments",
    tabs: [{ label: "Deployments", path: "deployments", members: true }, ...soon("Deployments")],
  },
  { key: "Observability", tabs: soon("Observability") },
  { key: "Security", tabs: soon("Security") },
  { key: "Insights", tabs: soon("Insights") },
];

/** Pull requests and the merge queue share a page's tabs too. */
export const PULLS: Section = {
  key: "Code",
  tabs: [
    { label: "Pull requests", path: "pulls", also: ["pull"] },
    { label: "Merge queue", path: "queue" },
  ],
};

function matches(rest: string, tab: Tab): boolean {
  return [tab.path, ...(tab.also ?? [])].some((path) => path !== "" && (rest === path || rest.startsWith(`${path}/`)));
}

/**
 * The tabs for the page at `rest` (the path under the project), if it
 * belongs to a page with more than one view.
 */
export function tabsFor(rest: string, member: boolean): Tab[] | null {
  for (const section of [...SECTIONS, PULLS]) {
    const visible = section.tabs.filter((tab) => member || !tab.members);
    if (visible.length > 1 && visible.some((tab) => matches(rest, tab))) return visible;
  }
  return null;
}

/** The first page of a section, for its sidebar link: a built one if any. */
export function entryOf(key: Section["key"]): Tab | undefined {
  return SECTIONS.find((section) => section.key === key)?.tabs[0];
}
