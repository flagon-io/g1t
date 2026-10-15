import { type ComponentProps, useId } from "react";

import { FieldLabel, Field as FormField } from "./ui/field";
import { Input as TextInput } from "./ui/input";

/**
 * "Type acme/web to confirm", above the box it is typed in. The words run
 * as one sentence that wraps however long the name is (a label is a flex
 * row otherwise, which split them into columns), and one click selects
 * the name to copy it.
 */
export function ConfirmName({
  confirm,
  id,
  ...input
}: { confirm: string; id?: string } & ComponentProps<typeof TextInput>) {
  const fallback = useId();
  const field = id ?? `${fallback}-confirm`;
  return (
    <FormField>
      <FieldLabel htmlFor={field} className="block leading-relaxed select-text">
        Type{" "}
        <span className="rounded bg-raised px-1 py-0.5 font-mono text-[0.8125rem] break-all text-fg select-all">
          {confirm}
        </span>{" "}
        to confirm
      </FieldLabel>
      <TextInput
        id={field}
        name="confirm"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        className="font-mono"
        {...input}
      />
    </FormField>
  );
}
