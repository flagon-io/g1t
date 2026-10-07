import { identity } from "../../lib/services.server";
import { Form } from "react-router";

import type { Route } from "./+types/keys";
import { page } from "../../lib/meta";
import { ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { DeleteButton } from "../../components/account-settings";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "SSH keys · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  return { keys: await identity.listSshKeys(user) };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  switch (form.get("intent")) {
    case "add-key": {
      const result = await identity.addSshKey(
        user,
        String(form.get("title") ?? ""),
        String(form.get("key") ?? ""),
      );
      return result.ok ? null : { keyError: result.error.message };
    }
    case "delete-key":
      await identity.removeSshKey(user, String(form.get("id") ?? ""));
      return null;
  }
  return null;
}

export default function SshKeySettings({ loaderData, actionData }: Route.ComponentProps) {
  const { keys } = loaderData;
  return (
    <section id="ssh-keys" className="scroll-mt-20">
      <ul className="divide-y divide-line rounded-md border border-line empty:hidden">
        {keys.map((key) => (
          <li key={key.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm">{key.title}</p>
              <p className="truncate font-mono text-xs text-muted">{key.fingerprint}</p>
            </div>
            <DeleteButton intent="delete-key" id={key.id} />
          </li>
        ))}
      </ul>
      {/* Keyed on the list, so a key once added leaves the fields empty for the next. */}
      <Form key={keys.length} method="post" className={`space-y-3 ${keys.length > 0 ? "mt-4" : ""}`}>
        <input type="hidden" name="intent" value="add-key" />
        <Field label="Title (optional)">
          <Input name="title" maxLength={100} />
        </Field>
        <Field label="Public key">
          <Input name="key" placeholder="ssh-ed25519 AAAA…" required />
        </Field>
        <ErrorText>{actionData?.keyError}</ErrorText>
        <SubmitButton pending="Adding…" match={{ intent: "add-key" }}>
          Add SSH key
        </SubmitButton>
      </Form>
    </section>
  );
}
