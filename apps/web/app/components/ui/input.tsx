import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";
import { notACredential } from "./index";

// shadcn/ui's input, styled with g1t's tokens. Unlike the older `Input` in
// ./index it takes a className, and fields that are not part of signing in
// still keep password managers out.

export const CONTROL =
  "w-full min-w-0 rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg outline-none transition-[border-color,box-shadow] placeholder:text-faint hover:border-line-strong focus-visible:border-accent-dim focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger/70";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...notACredential(props.autoComplete)} {...props} className={cn(CONTROL, "h-9", className)} />;
}

/**
 * Text either side of an input, joined into one control, as in
 * `workspace / name` or `https:// … .g1t.page`. Put addons and an input
 * inside; the group draws the border and the focus ring.
 */
export function InputGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-9 w-full min-w-0 items-stretch overflow-hidden rounded-md border border-line bg-bg text-sm transition-[border-color,box-shadow]",
        "hover:border-line-strong has-[:focus-visible]:border-accent-dim has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/25",
        "[&_input]:h-full [&_input]:rounded-none [&_input]:border-0 [&_input]:bg-transparent [&_input]:ring-0 [&_input]:focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

export function InputAddon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("flex shrink-0 items-center px-2.5 text-faint select-none", className)}
      {...props}
    />
  );
}
