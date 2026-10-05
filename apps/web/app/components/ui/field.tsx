import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Label } from "./label";

// shadcn/ui's field: a label, a control, a line of help and an error,
// spaced the same way on every form.
//
//   <Field>
//     <FieldLabel htmlFor="name">Name</FieldLabel>
//     <Input id="name" name="name" />
//     <FieldDescription>Shown on the project page.</FieldDescription>
//     <FieldError>{actionData?.error}</FieldError>
//   </Field>
//
// A group of radios or checkboxes goes in a <FieldSet> with a <FieldLegend>.

export function Field({ className, ...props }: ComponentProps<"div">) {
  return <div role="group" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return <Label className={cn("mb-0", className)} {...props} />;
}

export function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-xs leading-relaxed text-faint", className)} {...props} />;
}

export function FieldError({ className, children, ...props }: ComponentProps<"p"> & { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className={cn("text-xs text-danger", className)} {...props}>
      {children}
    </p>
  );
}

export function FieldSet({ className, ...props }: ComponentProps<"fieldset">) {
  return <fieldset className={cn("flex min-w-0 flex-col gap-3", className)} {...props} />;
}

export function FieldLegend({ className, ...props }: ComponentProps<"legend">) {
  return <legend className={cn("mb-3 text-sm font-medium text-muted", className)} {...props} />;
}

export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-6", className)} {...props} />;
}
