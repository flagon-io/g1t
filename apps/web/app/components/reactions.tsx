import { SmilePlus } from "lucide-react";
import { useFetcher } from "react-router";

import { REACTIONS, type ReactionContent, type ReactionGroup } from "@g1t/contracts";

import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const EMOJI = Object.fromEntries(REACTIONS.map((one) => [one.content, one])) as Record<
  ReactionContent,
  (typeof REACTIONS)[number]
>;

/** "ana, bo and g1t" for who reacted; "You" for the viewer. */
function who(users: string[], viewer: string | null) {
  const names = users.map((name) => (name === viewer ? "You" : name));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** `groups` with the viewer's reaction added or taken back, as the page shows it before the service answers. */
function applied(groups: ReactionGroup[], viewer: string, content: ReactionContent, remove: boolean): ReactionGroup[] {
  const next = groups
    .map((group) => {
      if (group.content !== content) return group;
      const users = remove ? group.users.filter((name) => name !== viewer) : group.users.includes(viewer) ? group.users : [...group.users, viewer];
      return { ...group, users, count: users.length };
    })
    .filter((group) => group.count > 0);
  if (!remove && !next.some((group) => group.content === content)) next.push({ content, count: 1, users: [viewer] });
  const order = REACTIONS.map((one) => one.content);
  return next.sort((a, b) => order.indexOf(a.content) - order.indexOf(b.content));
}

/**
 * How people (and g1t) reacted to a work item's or pull request's description
 * (no `commentId`) or to one of its comments: a pill per emoji with how
 * many, lit when the viewer is one of them, and who when hovered. Signed
 * in, a pill adds or takes back the viewer's own and the smiley offers the
 * rest; the page's action answers `react`. g1t's 👀 says it has seen what
 * it was asked and is on it.
 */
export function Reactions({
  reactions,
  commentId,
  viewer,
  className = "",
}: {
  reactions?: ReactionGroup[];
  commentId?: string;
  /** The signed-in viewer's username, or null: then the pills only show. */
  viewer: string | null;
  className?: string;
}) {
  const fetcher = useFetcher();
  let groups = reactions ?? [];
  // What the viewer just did, shown at once.
  const pending = fetcher.formData;
  if (viewer && pending?.get("action") === "react") {
    const content = String(pending.get("content")) as ReactionContent;
    if (EMOJI[content]) groups = applied(groups, viewer, content, pending.get("remove") === "1");
  }
  if (groups.length === 0 && !viewer) return null;
  const react = (content: ReactionContent, remove: boolean) =>
    fetcher.submit(
      { action: "react", comment: commentId ?? "", content, remove: remove ? "1" : "" },
      { method: "post", preventScrollReset: true },
    );
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`} aria-label="Reactions">
      {groups.map((group) => {
        const mine = viewer != null && group.users.includes(viewer);
        const { emoji, label } = EMOJI[group.content];
        return (
          <Hint key={group.content} label={`${who(group.users, viewer)} reacted with ${label.toLowerCase()}`}>
            <button
              type="button"
              aria-pressed={mine}
              aria-label={`${label}, ${group.count} ${group.count === 1 ? "reaction" : "reactions"}${mine ? ", including yours" : ""}`}
              disabled={!viewer}
              onClick={() => react(group.content, mine)}
              className={`flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs font-medium tabular-nums transition-colors disabled:cursor-default ${
                mine
                  ? "border-accent/60 bg-accent/15 text-accent hover:bg-accent/25"
                  : "border-line bg-surface text-muted hover:border-line-strong hover:bg-raised hover:text-fg"
              }`}
            >
              <span aria-hidden className="text-sm leading-none">
                {emoji}
              </span>
              {group.count}
            </button>
          </Hint>
        );
      })}
      {viewer && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              aria-label="Add a reaction"
              variant="outline"
              className="h-6 rounded-full bg-surface px-1.5 text-faint hover:bg-raised"
            >
              <SmilePlus size={14} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-1.5">
            <div className="flex gap-0.5">
              {REACTIONS.map(({ content, emoji, label }) => {
                const mine = groups.some((group) => group.content === content && group.users.includes(viewer));
                return (
                  <Hint key={content} label={label}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={label}
                      aria-pressed={mine}
                      className={`text-base ${mine ? "bg-accent/15" : ""}`}
                      onClick={() => react(content, mine)}
                    >
                      {emoji}
                    </Button>
                  </Hint>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
