/**
 * AI Elements' Conversation (registry.ai-sdk.dev/conversation.json), in
 * g1t's tokens: a scrolling log that follows new words to the bottom while
 * the reader is there, and stops following the moment they scroll up to
 * read (use-stick-to-bottom). A button takes them back down.
 */
import { ArrowDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps) {
  return <StickToBottom className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)} initial="smooth" resize="smooth" role="log" {...props} />;
}

export function ConversationContent({ className, ...props }: ComponentProps<typeof StickToBottom.Content>) {
  return <StickToBottom.Content className={cn("flex flex-col gap-6 px-5 py-4", className)} {...props} />;
}

export function ConversationEmptyState({ className, title, description, icon, children, ...props }: ComponentProps<"div"> & { title?: string; description?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-10 text-center", className)} {...props}>
      {children ?? (
        <>
          {icon && <div className="text-accent">{icon}</div>}
          <div className="space-y-1">
            {title && <h3 className="text-sm font-medium text-fg">{title}</h3>}
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
        </>
      )}
    </div>
  );
}

/** Back to the newest words, shown only while the reader is scrolled up. */
export function ConversationScrollButton({ className, ...props }: ComponentProps<typeof Button>) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label="Scroll to the newest"
      onClick={() => void scrollToBottom()}
      className={cn("absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-surface shadow-lg shadow-black/30", className)}
      {...props}
    >
      <ArrowDown size={15} />
    </Button>
  );
}
