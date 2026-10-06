import { Form } from "react-router";

import { Button } from "./ui";

/** One row's way out of a list in your settings: a key, a token, an application. */
export function DeleteButton({
  intent,
  id,
  label = "Delete",
}: {
  intent: string;
  id: string;
  label?: string;
}) {
  return (
    <Form method="post" className="ml-auto">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      <Button variant="quiet" type="submit">
        {label}
      </Button>
    </Form>
  );
}
