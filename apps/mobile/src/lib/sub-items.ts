/**
 * Sub-items: a work item can be split into work items under it, and a
 * parent shows how far along they are (closed, of all of them). Closing a
 * parent with open sub-items says what becomes of them: left open, closed
 * too, or moved under another work item. g1t never closes them silently.
 *
 * Kept free of React Native imports so `npm test` runs it under Node.
 */

/** A work item in brief, as a parent or a sub-item. */
export type ApiItemBrief = { number: number; title: string; state: "open" | "closed" };

/** How many of an item's sub-items are closed, of how many. */
export type SubItemProgress = { done: number; total: number };

/** What closing a parent does with its open sub-items. */
export type SubItemChoice = "leave" | "close" | "move";

/** The progress of these sub-items, or null with none. */
export function progressOf(subItems: Pick<ApiItemBrief, "state">[]): SubItemProgress | null {
  if (subItems.length === 0) return null;
  return { done: subItems.filter((one) => one.state === "closed").length, total: subItems.length };
}

/** "3 of 7 done", for the item's own screen. */
export function progressLabel(progress: SubItemProgress): string {
  return `${progress.done} of ${progress.total} done`;
}

/** "3/7", for a row of a list or a card on the board. */
export function progressShort(progress: SubItemProgress): string {
  return `${progress.done}/${progress.total}`;
}

/** How full the bar is, from 0 to 1. */
export function progressShare(progress: SubItemProgress): number {
  return progress.total > 0 ? Math.min(1, Math.max(0, progress.done / progress.total)) : 0;
}

/** The sub-items still open. */
export function openSubItems<T extends Pick<ApiItemBrief, "state">>(subItems: T[]): T[] {
  return subItems.filter((one) => one.state === "open");
}

/** "#230, #231 and #233". */
export function numberList(numbers: number[]): string {
  const refs = numbers.map((number) => `#${number}`);
  return refs.length <= 1 ? (refs[0] ?? "") : `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
}

/** What the close sheet says about an item's open sub-items. */
export function openSubItemsLabel(number: number, open: Pick<ApiItemBrief, "number">[]): string {
  const count = open.length === 1 ? "1 open sub-item" : `${open.length} open sub-items`;
  return `#${number} has ${count} (${numberList(open.map((one) => one.number))}).`;
}

/** The body of `POST …/close`: the reason, and what to do with open sub-items when asked. */
export function closeBody(reason: string, choice?: SubItemChoice, moveTo?: number): Record<string, unknown> {
  if (!choice) return { reason };
  return choice === "move" ? { reason, sub_items: choice, move_to: moveTo } : { reason, sub_items: choice };
}

/** A work item number typed in: "#212" or "212". Null for anything else. */
export function parseNumber(text: string): number | null {
  const match = /^#?\s*(\d+)$/.exec(text.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
