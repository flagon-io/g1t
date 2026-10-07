/**
 * Pinned and recent projects in the sidebar: the viewer's pins in the
 * workspace (up to eight, in their order), then what they opened last that
 * they have not pinned (up to five), then All projects. The projects
 * service keeps both; opening a project records it after the page is sent.
 */

/** A project as the sidebar lists it. */
export type ShortcutProject = { namespace: string; name: string; title?: string; isPrivate: boolean };

export const MAX_PINS = 8;
export const MAX_RECENT = 5;

const same = (a: { namespace: string; name: string }, b: { namespace: string; name: string }) =>
  a.namespace.toLowerCase() === b.namespace.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/**
 * Recent, with the project being looked at first when it is the
 * workspace's and not pinned: it was opened just now, before the projects
 * service has heard.
 */
export function recentWith(
  recent: ShortcutProject[],
  pinned: ShortcutProject[],
  current: ShortcutProject | null,
  workspace: string | null,
): ShortcutProject[] {
  const here = current && workspace && current.namespace.toLowerCase() === workspace.toLowerCase() && !pinned.some((p) => same(p, current)) ? current : null;
  const rest = recent.filter((project) => !pinned.some((p) => same(p, project)) && !(here && same(project, here)));
  return [...(here ? [here] : []), ...rest].slice(0, MAX_RECENT);
}

/** One change to the viewer's pins, as a form posts it. */
export type PinChange =
  | { intent: "pin"; slug: string; position: number | null }
  | { intent: "unpin"; slug: string }
  | { intent: "reorder"; slugs: string[] };

/** What a pin form asks for; null when it asks for nothing that makes sense. */
export function pinFromForm(form: FormData): PinChange | null {
  const intent = form.get("intent");
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  if (intent === "reorder") {
    const slugs = form.getAll("slug").map((value) => String(value).trim().toLowerCase()).filter(Boolean);
    return slugs.length > 0 && new Set(slugs).size === slugs.length ? { intent, slugs } : null;
  }
  if (!slug) return null;
  if (intent === "unpin") return { intent, slug };
  if (intent !== "pin") return null;
  const position = Number.parseInt(String(form.get("position") ?? ""), 10);
  return { intent, slug, position: Number.isFinite(position) && position >= 0 ? position : null };
}

/**
 * The pins in a new order after moving the one at `from` by `by` places
 * (-1 up, 1 down); null when it cannot move that way.
 */
export function movedPin<T>(pins: T[], from: number, by: number): T[] | null {
  const to = from + by;
  if (from < 0 || from >= pins.length || to < 0 || to >= pins.length || by === 0) return null;
  const next = [...pins];
  const [moving] = next.splice(from, 1);
  next.splice(to, 0, moving!);
  return next;
}
