/**
 * Choosing what you hear of: subscribing to one issue or pull request, from
 * its sidebar, and watching a repository, from its header. Both post to
 * the repository's `notifications` route (routes/repo/notifications.ts);
 * the events service keeps the choice and the inbox follows it.
 */
import { Bell, BellOff, Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useFetcher } from "react-router";

import { WATCH_EVENTS, type ThreadSubscription, type WatchEvent, type WatchLevel } from "@g1t/contracts";

import { SubmitButton } from "./ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { cn } from "../lib/cn";
import { WATCH_CHOICES, WATCH_EVENT_LABEL, subscriptionLine, watchLabel } from "../lib/inbox";

/**
 * The sidebar's Notifications box on an issue or pull request: one button
 * to subscribe or unsubscribe (or stop ignoring it), and a line saying
 * whether you hear of it, and why. While the choice is on its way, it
 * shows as made.
 */
export function SubscriptionBox({
  action,
  number,
  kind,
  subscription,
}: {
  /** The repository's notifications route: `/<owner>/<repo>/notifications`. */
  action: string;
  number: number;
  kind: "issue" | "pull";
  subscription: ThreadSubscription | null;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const asked = fetcher.formData?.get("intent");
  // What it will be once the choice lands.
  const shown: ThreadSubscription | null =
    asked === "subscribe"
      ? { ...(subscription ?? EMPTY), subscribed: true, ignored: false, reason: subscription?.subscribed ? subscription.reason : "manual" }
      : asked === "unsubscribe" || asked === "default"
        ? { ...(subscription ?? EMPTY), subscribed: false, ignored: false, reason: null }
        : subscription;
  const intent = shown?.ignored ? "default" : shown?.subscribed ? "unsubscribe" : "subscribe";
  const label = intent === "default" ? "Stop ignoring" : intent === "unsubscribe" ? "Unsubscribe" : "Subscribe";
  return (
    <section>
      <h3 className="text-sm font-medium">Notifications</h3>
      <fetcher.Form method="post" action={action} className="mt-2">
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="number" value={number} />
        <SubmitButton variant="outline" size="sm" fetcher={fetcher} className="w-full">
          {intent === "subscribe" ? <Bell size={14} /> : <BellOff size={14} />}
          {label}
        </SubmitButton>
      </fetcher.Form>
      <p className="mt-2 text-xs text-muted">{subscriptionLine(shown, kind)}</p>
      {fetcher.data?.error && <p className="mt-1 text-xs text-danger">{fetcher.data.error}</p>}
    </section>
  );
}

const EMPTY: ThreadSubscription = { subscribed: false, ignored: false, reason: null, repo: null, number: null, updatedAt: null };

/**
 * The repository header's Watch menu: participating and @mentions (the
 * default), all activity, ignore, or custom, with the kinds a custom watch
 * follows checked under it. Each choice is saved as it is made.
 */
export function WatchMenu({ action, level, events }: { action: string; level: WatchLevel; events: WatchEvent[] }) {
  const fetcher = useFetcher<{ error?: string }>();
  // The choice on its way, as it will be.
  const pendingLevel = fetcher.formData?.get("level");
  const shownLevel = (typeof pendingLevel === "string" ? pendingLevel : level) as WatchLevel;
  const shownEvents = fetcher.formData ? (fetcher.formData.getAll("event").map(String) as WatchEvent[]) : events;
  // Custom opened to choose, before anything is chosen.
  const [choosing, setChoosing] = useState(false);
  const custom = shownLevel === "custom" || choosing;

  const save = (next: WatchLevel, kinds: WatchEvent[] = []) => {
    const form = new FormData();
    form.set("intent", "watch");
    form.set("level", next);
    for (const kind of kinds) form.append("event", kind);
    fetcher.submit(form, { method: "post", action });
  };
  const toggle = (kind: WatchEvent) => {
    const had = shownLevel === "custom" ? shownEvents : [];
    const next = had.includes(kind) ? had.filter((event) => event !== kind) : [...had, kind];
    const ordered = WATCH_EVENTS.filter((event) => next.includes(event));
    // Nothing left to follow is the default.
    save(ordered.length > 0 ? "custom" : "participating", ordered);
  };

  return (
    <DropdownMenu onOpenChange={(open) => !open && setChoosing(false)}>
      <DropdownMenuTrigger
        aria-label={`Watch: ${WATCH_CHOICES.find((choice) => choice.level === shownLevel)?.label ?? "Participating and @mentions"}`}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-[0.8125rem] text-fg/80 transition-colors outline-none hover:border-line-strong hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:border-line-strong",
          fetcher.state !== "idle" && "opacity-70",
        )}
      >
        {shownLevel === "ignore" ? <EyeOff size={14} /> : <Eye size={14} />}
        {/* The eye says it on a phone; the aria-label says it in full. */}
        <span className="hidden sm:inline">{watchLabel(shownLevel)}</span>
        <ChevronDown size={13} className="text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Notifications from this repository</DropdownMenuLabel>
        {WATCH_CHOICES.map((choice) => {
          const selected = choice.level === "custom" ? custom : !choosing && shownLevel === choice.level;
          return (
            <DropdownMenuItem
              key={choice.level}
              onSelect={(event) => {
                if (choice.level === "custom") {
                  // Stays open, to choose what to follow.
                  event.preventDefault();
                  setChoosing(true);
                  return;
                }
                setChoosing(false);
                if (choice.level !== shownLevel) save(choice.level);
              }}
              className="items-start"
            >
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                {selected && <Check size={14} className="!text-accent" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-fg">{choice.label}</span>
                <span className="block text-xs text-muted">{choice.detail}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
        {custom && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Also tell me about</DropdownMenuLabel>
            {WATCH_EVENTS.map((kind) => {
              const on = shownLevel === "custom" && shownEvents.includes(kind);
              return (
                <DropdownMenuItem
                  key={kind}
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onSelect={(event) => {
                    event.preventDefault();
                    toggle(kind);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      on ? "border-accent bg-accent text-bg" : "border-line-strong",
                    )}
                  >
                    {on && <Check size={11} className="!text-bg" />}
                  </span>
                  {WATCH_EVENT_LABEL[kind]}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
        {fetcher.data?.error && <p className="px-2 py-1.5 text-xs text-danger">{fetcher.data.error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
