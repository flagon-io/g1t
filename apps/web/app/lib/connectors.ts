/**
 * The integrations directory: the connector catalog (@g1t/contracts/connectors)
 * filtered, searched and sorted into what a workspace, or a person, has
 * connected, can connect now, and will be able to soon.
 */

import {
  CONNECTOR_CATEGORIES,
  type ConnectorCategory,
  type ConnectorScope,
  type ConnectorView,
} from "@g1t/contracts/connectors";

/** "all", or one category: what the directory's navigation selects. */
export type CategoryFilter = ConnectorCategory | "all";

/** What is connected, by connector id: how it is doing, for its card. */
export type ConnectedState = {
  /** A line about it: an account, how many connections. */
  detail: string | null;
  /** Something is wrong with it, said plainly. */
  problem: string | null;
  /** Where it is managed, when that is not its setup page. */
  manage: string | null;
};

export type Directory = {
  connected: ConnectorView[];
  available: ConnectorView[];
  soon: ConnectorView[];
};

/** The category a `?category=` asks for, or all of them. */
export function categoryFilter(value: string | null | undefined): CategoryFilter {
  return CONNECTOR_CATEGORIES.some((category) => category.id === value) ? (value as ConnectorCategory) : "all";
}

/** A category's title. */
export function categoryTitle(id: ConnectorCategory): string {
  return CONNECTOR_CATEGORIES.find((category) => category.id === id)?.title ?? id;
}

/** Lowercased, without accents or punctuation, for matching. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether a connector answers a search: every word in its name, description, category, tags or keywords. */
export function matchesQuery(view: ConnectorView, query: string): boolean {
  const words = fold(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold([view.name, view.description, categoryTitle(view.category), ...view.capabilities, ...view.keywords].join(" "));
  const compact = haystack.replace(/ /g, "");
  return words.every((word) => haystack.includes(word) || compact.includes(word));
}

/**
 * The directory for one category and search: what is connected first, then
 * what can be connected now, then what is coming. Search spans every
 * category, so a match in another one is never hidden.
 */
export function arrange(
  views: ConnectorView[],
  { category, query, connected }: { category: CategoryFilter; query: string; connected: ReadonlySet<string> },
): Directory {
  const searching = query.trim().length > 0;
  const shown = views.filter(
    (view) => (searching || category === "all" || view.category === category) && matchesQuery(view, query),
  );
  return {
    connected: shown.filter((view) => connected.has(view.id)),
    available: shown.filter((view) => view.status === "available" && !connected.has(view.id)),
    soon: shown.filter((view) => view.status === "soon" && !connected.has(view.id)),
  };
}

/** How many connectors each category has, for its row in the navigation; `all` is every one. */
export function categoryCounts(views: ConnectorView[]): Record<CategoryFilter, number> {
  const counts = { all: views.length } as Record<CategoryFilter, number>;
  for (const category of CONNECTOR_CATEGORIES) counts[category.id] = 0;
  for (const view of views) counts[view.category] += 1;
  return counts;
}

/** The categories with something in them for `views`, in catalog order. */
export function categoriesWith(views: ConnectorView[]): { id: ConnectorCategory; title: string }[] {
  const present = new Set(views.map((view) => view.category));
  return CONNECTOR_CATEGORIES.filter((category) => present.has(category.id));
}

/** Connectors grouped under their categories, in catalog order, leaving out empty ones. */
export function groupByCategory(views: ConnectorView[]): { id: ConnectorCategory; title: string; views: ConnectorView[] }[] {
  return CONNECTOR_CATEGORIES.map((category) => ({
    ...category,
    views: views.filter((view) => view.category === category.id),
  })).filter((group) => group.views.length > 0);
}

/** The letters on a connector's tile: two words' initials, or a name's capitals ("PagerDuty" → "PD"). */
export function monogram(name: string): string {
  const words = name.split(/[\s.\-/]+/).filter((word) => /[A-Za-z0-9]/.test(word));
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const word = words[0] ?? name;
  const capitals = word.slice(1).match(/[A-Z0-9]/);
  return capitals ? (word[0]! + capitals[0]).toUpperCase() : word.slice(0, 1).toUpperCase();
}

/** A tile's colour, always the same for the same connector. */
const PALETTE = ["#8b8ff0", "#5b8def", "#5eead4", "#4ade80", "#facc15", "#fb923c", "#f87171", "#f472b6", "#c084fc", "#a1a1aa", "#38bdf8", "#a3e635"];

export function tileColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

/** Where a request for a connector goes: an email to g1t, filled in. */
export function askHref({
  connector,
  scope,
  workspace,
  address,
}: {
  connector: Pick<ConnectorView, "id" | "name">;
  scope: ConnectorScope;
  workspace: string | null;
  address: string;
}): string {
  const subject = `Integration request: ${connector.name}`;
  const body = [
    `I would like g1t to connect to ${connector.name} (${connector.id}).`,
    scope === "workspace" && workspace ? `For the workspace: ${workspace}` : "For my own account.",
    "",
    "What we would use it for:",
    "",
  ].join("\n");
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
