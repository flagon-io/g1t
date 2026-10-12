import { ArrowUpRight, X } from "lucide-react";

import type { CardAction, FeedNotification } from "@g1t/contracts";

import { Button, type ButtonVariant } from "../ui/button";
import { Card } from "../ui/card";
import { Hint } from "../ui/hint";
import { cn } from "../../lib/cn";
import { currentSink, dismiss, settle, useWaitingCards } from "../../lib/notify-client";
import { notificationActions } from "../../lib/notify-store";

// A chat card's links on a notification about it (Open, say). Following
// one puts the notification away. Buttons that ran something were an
// agent's, and nothing answers them any more, so they are not shown.

/** A notification's links are the smallest buttons, taller to a finger on a phone; the action's style names the variant. */
const VARIANT: Record<NonNullable<CardAction["style"]>, ButtonVariant> = { primary: "accent", danger: "destructive", default: "outline" };

export function NotificationCardActions({
  notification,
  onNavigate,
  className,
}: {
  notification: FeedNotification;
  /** After a link is followed: closes the panel it is in. */
  onNavigate?: () => void;
  className?: string;
}) {
  const actions = notificationActions(notification);
  if (!actions.length) return null;
  return (
    <div role="group" aria-label={`${notification.title}: links`} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {actions.map((action) => (
        <Button
          key={action.id}
          type="button"
          variant={VARIANT[action.style ?? "default"]}
          size="xs"
          className="max-sm:h-9 max-sm:px-3"
          onClick={() => {
            dismiss(notification.id);
            onNavigate?.();
            currentSink().open(action.href!);
          }}
        >
          {action.label}
          <ArrowUpRight size={12} aria-hidden="true" className="-mr-0.5 text-faint" />
        </Button>
      ))}
    </div>
  );
}

/**
 * The chat cards waiting on the person, at the top of the notifications
 * panel: each one's title and preview, a link to where it is, and its
 * actions. Gone once acted on here, or after a day.
 */
export function WaitingCards({ onNavigate }: { onNavigate?: () => void }) {
  const waiting = useWaitingCards();
  if (!waiting.length) return null;
  return (
    <section aria-labelledby="waiting-cards" className="mb-4">
      <h3 id="waiting-cards" className="mb-2 text-xs font-medium text-muted">
        Waiting on you in chat
      </h3>
      <ul className="space-y-2">
        {waiting.map((notification) => (
          <Card asChild key={notification.id} radius="lg" className="relative p-3">
            <li>
              <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.75 rounded-r bg-accent" />
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onNavigate?.();
                    currentSink().open(notification.href);
                  }}
                  className="min-w-0 grow rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  <span className="block truncate text-sm font-medium text-fg hover:underline">{notification.title}</span>
                  {notification.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{notification.body}</span>}
                </button>
                <Hint label="Put away">
                  <Button
                    type="button"
                    aria-label="Put away"
                    onClick={() => settle(notification.id)}
                    variant="ghost" size="icon"
                    className="size-6 text-faint"
                  >
                    <X size={14} />
                  </Button>
                </Hint>
              </div>
              <NotificationCardActions notification={notification} onNavigate={onNavigate} className="mt-2.5" />
            </li>
          </Card>
        ))}
      </ul>
    </section>
  );
}
