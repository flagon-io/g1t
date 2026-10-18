/**
 * What `#N` names, asked of the work service (`resolveRef`, the rules in
 * lib/refs.ts), as a page to send the browser to or as the card a
 * reference shows on hover.
 */
import type { RefTarget, RepoPath, Viewer } from "@g1t/contracts";

import { itemPath } from "./refs";
import { work } from "./services.server";

/** Where `#number` is read: a repository, or a workspace alone. */
export type RefScope = { repo: RepoPath } | { workspace: string };

/**
 * What a reference's card shows (components/chat/ref-chip.tsx): a work item
 * or a pull request, as the viewer may see it, and where it is.
 */
export type RefCard = {
  kind: "item" | "pull";
  /** A pull request's repository, `owner/name`; null for a work item. */
  repo: string | null;
  /** The workspace a work item is numbered in, or a pull request's repository's. */
  workspace: string;
  number: number;
  title: string;
  state: string;
  /** Its page. */
  to: string;
};

/** What `#number` names for the viewer, read in `scope`; none when the service cannot say. */
export async function resolveRef(viewer: Viewer, scope: RefScope, number: number): Promise<RefTarget> {
  if (!Number.isInteger(number) || number < 1) return { kind: "none" };
  return work.resolveRef(viewer, scope, number).catch((): RefTarget => ({ kind: "none" }));
}

/** The page a resolved reference is: a work item's or a pull request's; null for none. */
export function refTargetPath(target: RefTarget): string | null {
  if (target.kind === "work_item") return itemPath(target.workspace, target.number);
  if (target.kind === "pull") return `/${target.repo}/pull/${target.number}`;
  return null;
}

/** Where `#number`, read in `scope`, leads; null when it names nothing the viewer can see. */
export async function refPath(viewer: Viewer, scope: RefScope, number: number): Promise<string | null> {
  return refTargetPath(await resolveRef(viewer, scope, number));
}

/** The card for `#number` read in `scope`; null when it names nothing the viewer can see. */
export async function refCard(viewer: Viewer, scope: RefScope, number: number): Promise<RefCard | null> {
  const target = await resolveRef(viewer, scope, number);
  if (target.kind === "work_item") {
    const found = await work.getWorkItem(target.workspace, target.number, viewer).catch(() => null);
    if (!found?.ok) return null;
    const { item } = found.value;
    return {
      kind: "item",
      repo: null,
      workspace: item.workspace,
      number: item.number,
      title: item.title,
      state: item.state === "closed" && item.reason === "not_planned" ? "not planned" : item.state,
      to: itemPath(item.workspace, item.number),
    };
  }
  if (target.kind === "pull") {
    const [namespace = "", name = ""] = target.repo.split("/");
    const found = await work.getPull({ namespace, name }, target.number, viewer).catch(() => null);
    if (!found?.ok) return null;
    return {
      kind: "pull",
      repo: target.repo,
      workspace: namespace.toLowerCase(),
      number: target.number,
      title: found.value.pull.title,
      state: found.value.pull.status,
      to: `/${target.repo}/pull/${target.number}`,
    };
  }
  return null;
}
