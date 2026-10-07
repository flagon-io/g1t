import { Form } from "react-router";

import { SubmitButton } from "./ui";

/**
 * One row's way out of a list in your settings: a key, a token, an
 * application. It says it is working until the row has gone.
 */
export function DeleteButton({
  intent,
  id,
  label = "Delete",
  pending = "Deleting…",
}: {
  intent: string;
  id: string;
  label?: string;
  /** The words while it works. */
  pending?: string;
}) {
  return (
    <Form method="post" className="ml-auto">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="quiet" pending={pending} match={{ intent, id }}>
        {label}
      </SubmitButton>
    </Form>
  );
}
