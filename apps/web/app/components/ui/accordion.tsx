import { ChevronDown } from "lucide-react";
import { Accordion as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's accordion, styled with g1t's tokens: a stack of sections in
// one panel, each opening under its heading, one at a time (`type="single"
// collapsible`) or any number (`type="multiple"`). For questions and answers
// and the like; a list of rows that each open on their own stays <details>.

export const Accordion = Primitive.Root;

export function AccordionItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item data-slot="accordion-item" className={cn("border-b border-line last:border-b-0", className)} {...props} />;
}

export function AccordionTrigger({ className, children, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Header className="flex">
      <Primitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "flex flex-1 items-center justify-between gap-3 py-3 text-left text-sm font-medium outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown size={16} className="shrink-0 text-faint transition-transform" aria-hidden="true" />
      </Primitive.Trigger>
    </Primitive.Header>
  );
}

export function AccordionContent({ className, children, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content data-slot="accordion-content" className="overflow-hidden text-sm text-muted" {...props}>
      <div className={cn("pb-3", className)}>{children}</div>
    </Primitive.Content>
  );
}
