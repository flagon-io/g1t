/**
 * A work item's page's keys, kept apart from the rest of the page's logic
 * (lib/work-item-page.ts) so the app bar's shortcuts dialog lists them
 * without pulling that in. Pure, so it is tested under Node.
 */

/** What a key does on a work item's page. */
export type ItemCommand = "edit" | "assignee" | "agent" | "project" | "plan" | "milestone" | "labels" | "blocked" | "next" | "previous" | "claim" | "close";

/** The page's keys, as the shortcuts dialog and the panel's hints write them. */
export const ITEM_KEYS: { key: string; command: ItemCommand; what: string }[] = [
  { key: "E", command: "edit", what: "Edit the title and description" },
  { key: "A", command: "assignee", what: "Assignees" },
  { key: "D", command: "agent", what: "Start an agent" },
  { key: "P", command: "project", what: "Project" },
  { key: "H", command: "plan", what: "Plan: horizon, appetite, budget" },
  { key: "M", command: "milestone", what: "Milestone" },
  { key: "L", command: "labels", what: "Labels" },
  { key: "B", command: "blocked", what: "Blocked by" },
  { key: "I", command: "claim", what: "Claim it" },
  { key: "Shift C", command: "close", what: "Close it" },
  { key: "J", command: "next", what: "Next work item in the list you came from" },
  { key: "K", command: "previous", what: "Previous work item" },
];

const PLAIN: Record<string, ItemCommand> = {
  e: "edit",
  a: "assignee",
  d: "agent",
  p: "project",
  h: "plan",
  m: "milestone",
  l: "labels",
  b: "blocked",
  j: "next",
  k: "previous",
  i: "claim",
};

/** The key hint for a command, as `ITEM_KEYS` writes it. */
export function keyFor(command: ItemCommand): string {
  return ITEM_KEYS.find((one) => one.command === command)?.key ?? "";
}

/**
 * What a key press does, or null: never while typing in a field
 * (`typing`, components/command-palette.tsx's `inTextField`), with Ctrl,
 * ⌘ or Alt held (those are the browser's and the site's), or repeated by
 * holding the key down. Shift turns C into Close and every other letter
 * into nothing.
 */
export function itemCommandOf(
  event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean },
  typing: boolean,
): ItemCommand | null {
  if (typing || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null;
  if (event.key.length !== 1) return null;
  const letter = event.key.toLowerCase();
  if (event.shiftKey) return letter === "c" ? "close" : null;
  return PLAIN[letter] ?? null;
}
