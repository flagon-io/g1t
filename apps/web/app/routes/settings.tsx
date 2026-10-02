import { identity } from "../lib/services.server";
import { Form } from "react-router";

import type { Route } from "./+types/settings";
import { Button, ErrorText, Field, Input, TimeAgo } from "../components/ui";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Settings · g1t" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const [keys, tokens, applications] = await Promise.all([
    identity.listSshKeys(user),
    identity.listAccessTokens(user),
    identity.listOAuthGrants(user),
  ]);
  return { user, keys, tokens, applications };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const id = String(form.get("id") ?? "");

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
      await identity.removeSshKey(user, id);
      return null;
    case "add-token": {
      const created = await identity.createAccessToken(
        user,
        String(form.get("name") ?? ""),
      );
      return { newToken: created.token };
    }
    case "delete-token":
      await identity.removeAccessToken(user, id);
      return null;
    case "sign-out-application":
      await identity.revokeOAuthGrant(user, id);
      return null;
  }
  return null;
}

function DeleteButton({
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

export default function Settings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, keys, tokens, applications } = loaderData;
  return (
    <main className="mx-auto max-w-2xl space-y-12 px-4 py-12">
      <h1 className="text-xl font-semibold">
        Settings <span className="font-mono text-muted">{user.username}</span>
      </h1>

      <section>
        <h2 className="font-medium">SSH keys</h2>
        <ul className="mt-4 divide-y divide-line rounded-md border border-line empty:hidden">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm">{key.title}</p>
                <p className="truncate font-mono text-xs text-muted">
                  {key.fingerprint}
                </p>
              </div>
              <DeleteButton intent="delete-key" id={key.id} />
            </li>
          ))}
        </ul>
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="add-key" />
          <Field label="Title (optional)">
            <Input name="title" maxLength={100} />
          </Field>
          <Field label="Public key">
            <Input name="key" placeholder="ssh-ed25519 AAAA…" required />
          </Field>
          <ErrorText>{actionData?.keyError}</ErrorText>
          <Button type="submit">Add SSH key</Button>
        </Form>
      </section>

      <section>
        <h2 className="font-medium">Access tokens</h2>
        <p className="mt-1 text-sm text-muted">
          Use a token as the password when git asks for one over HTTPS, and to
          authenticate agents and the API.
        </p>
        {actionData?.newToken && (
          <div className="mt-4 rounded-md border border-accent/40 bg-surface p-4">
            <p className="text-sm">Copy it now. It will not be shown again.</p>
            <pre className="mt-2 overflow-x-auto font-mono text-sm text-accent">
              {actionData.newToken}
            </pre>
          </div>
        )}
        <ul className="mt-4 divide-y divide-line rounded-md border border-line empty:hidden">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center gap-4 px-4 py-3">
              <p className="text-sm">{token.name}</p>
              <DeleteButton intent="delete-token" id={token.id} />
            </li>
          ))}
        </ul>
        <Form method="post" className="mt-4 flex items-end gap-3">
          <input type="hidden" name="intent" value="add-token" />
          <div className="grow">
            <Field label="Name">
              <Input name="name" maxLength={100} placeholder="laptop" />
            </Field>
          </div>
          <Button type="submit">Create token</Button>
        </Form>
      </section>

      <section>
        <h2 className="font-medium">Connected applications</h2>
        <p className="mt-1 text-sm text-muted">
          Applications you signed in to through your browser, such as an agent
          connected to the g1t MCP server. Signing one out ends its access at
          once.
        </p>
        {applications.length === 0 ? (
          <p className="mt-4 text-sm text-faint">None yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-md border border-line">
            {applications.map((application) => (
              <li key={application.id} className="flex items-center gap-4 px-4 py-3">
                <div>
                  <p className="text-sm">{application.clientName}</p>
                  <p className="text-xs text-faint">
                    Connected <TimeAgo at={application.createdAt} /> · last used{" "}
                    <TimeAgo at={application.lastUsedAt} />
                  </p>
                </div>
                <DeleteButton
                  intent="sign-out-application"
                  id={application.id}
                  label="Sign out"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
