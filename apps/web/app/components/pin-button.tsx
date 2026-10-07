/**
 * Pinning a project, so it stays at the top of the workspace's sidebar:
 * a button on the project's header and on each row of the Projects page.
 * Posts to the workspace's pins route (routes/workspace/pins.ts); while it
 * is on its way, it shows as done.
 */
import { Pin } from "lucide-react";
import { useFetcher } from "react-router";

import { cn } from "../lib/cn";

export function PinButton({
  workspace,
  slug,
  name,
  pinned,
  compact,
  className,
}: {
  workspace: string;
  slug: string;
  /** For what the button says to a screen reader. */
  name: string;
  pinned: boolean;
  /** Only the pin, as on a row; the header says it in words too. */
  compact?: boolean;
  className?: string;
}) {
  const fetcher = useFetcher<{ error: string | null }>({ key: `pin:${workspace}/${slug}` });
  const asked = fetcher.formData?.get("intent");
  const shown = asked === "pin" ? true : asked === "unpin" ? false : pinned;
  const label = shown ? `Unpin ${name}` : `Pin ${name}`;
  const error = fetcher.state === "idle" ? fetcher.data?.error : null;
  return (
    <fetcher.Form method="post" action={`/${workspace}/-/pins`} className={cn("relative flex", className)}>
      <input type="hidden" name="intent" value={shown ? "unpin" : "pin"} />
      <input type="hidden" name="slug" value={slug} />
      <button
        type="submit"
        aria-label={label}
        aria-pressed={shown}
        title={error ?? (shown ? "Unpin from the sidebar" : "Pin to the sidebar")}
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-[0.8125rem] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent",
          compact
            ? "relative z-10 size-8 hover:bg-raised"
            : "h-8 border border-line px-2.5 text-fg/80 hover:border-line-strong hover:bg-surface hover:text-fg",
          shown ? "text-accent" : compact ? "text-faint hover:text-fg" : "",
          error && "text-danger",
        )}
      >
        <Pin size={14} className={shown ? "fill-current" : undefined} />
        {!compact && <span className="hidden sm:inline">{shown ? "Unpin" : "Pin"}</span>}
      </button>
    </fetcher.Form>
  );
}
