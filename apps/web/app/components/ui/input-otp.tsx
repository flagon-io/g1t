import { OTPInput, OTPInputContext } from "input-otp";
import { type ComponentProps, useContext } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's input OTP, styled with g1t's tokens: a one-time code drawn as
// a box per character over one real <input>, so autofill, password
// managers and pasting work as with any field, and the form posts the
// input's `name` as one value. Put slots in an InputOTPGroup, the groups
// apart with an InputOTPSeparator. `aria-invalid` on the InputOTP marks
// every box.

export function InputOTP({ className, containerClassName, ...props }: ComponentProps<typeof OTPInput>) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn("group/otp flex items-center gap-2 has-disabled:opacity-50", containerClassName)}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

export function InputOTPGroup({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="input-otp-group" className={cn("flex items-center", className)} {...props} />;
}

export function InputOTPSlot({ index, className, ...props }: ComponentProps<"div"> & { index: number }) {
  const context = useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = context?.slots[index] ?? {};
  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        "relative flex h-12 w-10 items-center justify-center border-y border-r border-line bg-bg font-mono text-xl text-fg tabular-nums transition-[border-color,box-shadow] sm:h-13 sm:w-11",
        "first:rounded-l-md first:border-l last:rounded-r-md",
        "data-[active=true]:z-10 data-[active=true]:border-accent-dim data-[active=true]:ring-2 data-[active=true]:ring-accent/25",
        "group-has-aria-invalid/otp:border-danger/70",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-px animate-caret-blink bg-fg motion-reduce:animate-none" />
        </div>
      )}
    </div>
  );
}

export function InputOTPSeparator(props: ComponentProps<"div">) {
  return <div data-slot="input-otp-separator" role="separator" className="h-px w-2.5 shrink-0 bg-line-strong" {...props} />;
}
