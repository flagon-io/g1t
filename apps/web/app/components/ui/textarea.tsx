import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";
import { notACredential } from "./index";
import { CONTROL } from "./input";

// shadcn/ui's textarea, styled with g1t's tokens.

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      {...notACredential(props.autoComplete)}
      {...props}
      className={cn(CONTROL, "min-h-20 resize-y leading-relaxed", className)}
    />
  );
}
