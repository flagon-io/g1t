import { identity } from "../../lib/services.server";
import { Form, Link } from "react-router";

import type { Route } from "./+types/tokens";
import { page } from "../../lib/meta";
import { Button, Field, Input, TimeAgo } from "../../components/ui";
import { DeleteButton } from "../../components/account-settings";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Access tokens · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  return { user, tokens: await identity.listAccessTokens(user) };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  switch (form.get("intent")) {
    case "add-token": {
      const created = await identity.createAccessToken(user, String(form.get("label") ?? ""));
      return { newToken: created.token };
    }
    case "delete-token":
      await identity.removeAccessToken(user, String(form.get("id") ?? ""));
      return null;
  }
  return null;
}

export default function TokenSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { user, tokens } = loaderData;
  return (
    <section id="tokens" className="scroll-mt-20">
      {(user.workspaces ?? []).length > 0 && (
        <p className="text-sm text-muted">
          For CI and integrations that work for a team, use a workspace's own tokens instead:{" "}
          {(user.workspaces ?? []).map((membership, i) => (
            <span key={membership.slug}>
              {i > 0 && ", "}
              <Link to={`/${membership.slug}/-/tokens`} className="font-mono text-fg underline underline-offset-4">
                {membership.slug}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
      {actionData?.newToken && (
        <div className="mt-4 rounded-md border border-accent/40 bg-surface p-4">
          <p className="text-sm">Copy it now. It will not be shown again.</p>
          <pre className="mt-2 overflow-x-auto font-mono text-sm text-accent">{actionData.newToken}</pre>
        </div>
      )}
      <ul className="mt-4 divide-y divide-line rounded-md border border-line empty:hidden">
        {tokens.map((token) => (
          <li key={token.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{token.name}</p>
              <p className="text-xs text-faint">
                Created <TimeAgo at={token.createdAt} /> ·{" "}
                {token.lastUsedAt ? (
                  <>
                    last used <TimeAgo at={token.lastUsedAt} />
                  </>
                ) : (
                  "never used"
                )}
              </p>
            </div>
            <DeleteButton intent="delete-token" id={token.id} />
          </li>
        ))}
      </ul>
      <Form method="post" className="mt-4 flex items-end gap-3">
        <input type="hidden" name="intent" value="add-token" />
        <div className="grow">
          <Field label="Name">
            <Input name="label" maxLength={100} placeholder="laptop" />
          </Field>
        </div>
        <Button type="submit">Create token</Button>
      </Form>
    </section>
  );
}
