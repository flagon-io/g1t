import { identity } from "../../lib/services.server";
import { Form, Link, redirect, useSearchParams } from "react-router";

import { presetScopes, type AccessToken } from "@g1t/contracts";

import type { Route } from "./+types/tokens";
import { page } from "../../lib/meta";
import {
  Button,
  ButtonLink,
  ErrorText,
  Field,
  Input,
  TimeAgo,
} from "../../components/ui";
import { DeleteButton } from "../../components/account-settings";
import {
  AccessSummary,
  ExpiryField,
  ScopeChecklist,
} from "../../components/token-scopes";
import {
  describeExpiry,
  expiryTtl,
  grantFromForm,
} from "../../lib/token-scopes";
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
      const grant = grantFromForm(form);
      if (!grant.ok)
        return {
          newToken: null,
          created: null,
          error: grant.error,
          editing: null,
        };
      const created = await identity.createAccessToken(
        user,
        String(form.get("label") ?? ""),
        expiryTtl(form.get("expires")),
        { ...grant.value, listed: true },
      );
      return {
        newToken: created.token,
        created: created.info,
        error: null,
        editing: null,
      };
    }
    case "update-token": {
      const id = String(form.get("id") ?? "");
      const grant = grantFromForm(form);
      if (!grant.ok)
        return {
          newToken: null,
          created: null,
          error: grant.error,
          editing: id,
        };
      const updated = await identity.updateAccessToken(user, id, grant.value);
      if (!updated.ok)
        return {
          newToken: null,
          created: null,
          error: updated.error.message,
          editing: id,
        };
      throw redirect("/settings/tokens");
    }
    case "delete-token":
      await identity.removeAccessToken(user, String(form.get("id") ?? ""));
      return null;
  }
  return null;
}

export default function TokenSettings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, tokens } = loaderData;
  const [params] = useSearchParams();
  const editing = actionData?.editing ?? params.get("edit");
  const workspaces = (user.workspaces ?? []).map(
    (membership) => membership.slug,
  );
  const created = actionData?.created;
  return (
    <section id="tokens" className="scroll-mt-20">
      {workspaces.length > 0 && (
        <p className="text-sm text-muted">
          For CI and integrations that work for a team, use a workspace's own
          tokens instead:{" "}
          {workspaces.map((slug, i) => (
            <span key={slug}>
              {i > 0 && ", "}
              <Link
                to={`/${slug}/-/tokens`}
                className="font-mono text-fg underline underline-offset-4"
              >
                {slug}
              </Link>
            </span>
          ))}
          .
        </p>
      )}
      {actionData?.newToken && (
        <div className="mt-4 rounded-md border border-accent/40 bg-surface p-4">
          <p className="text-sm">
            {created ? (
              <span className="font-medium">{created.name}</span>
            ) : (
              "Your token"
            )}{" "}
            is ready. Copy it now. It will not be shown again.
          </p>
          <pre className="mt-2 font-mono text-sm break-all whitespace-pre-wrap text-accent">
            {actionData.newToken}
          </pre>
          {created && (
            <>
              <AccessSummary holder={created} className="mt-3" />
              <p className="mt-1.5 text-xs text-faint">
                {describeExpiry(created.expiresAt)}
              </p>
            </>
          )}
        </div>
      )}
      <ul className="mt-4 divide-y divide-line rounded-md border border-line empty:hidden">
        {tokens.map((token) => (
          <TokenRow
            key={token.id}
            token={token}
            editing={editing === token.id}
            error={actionData?.editing === token.id ? actionData.error : null}
          />
        ))}
      </ul>

      {!editing && (
        <Form
          method="post"
          className="mt-8 space-y-5 rounded-md border border-line p-4 sm:p-5"
        >
          <input type="hidden" name="intent" value="add-token" />
          <h2 className="font-medium">New token</h2>
          <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
            <Field label="Name" hint="Name it after what will use it.">
              <Input
                name="label"
                maxLength={100}
                placeholder="laptop"
                required
              />
            </Field>
            <ExpiryField />
          </div>
          <ScopeChecklist initial={presetScopes("agent")} />
          {!actionData?.editing && <ErrorText>{actionData?.error}</ErrorText>}
          <Button type="submit">Create token</Button>
        </Form>
      )}
    </section>
  );
}

function TokenRow({
  token,
  editing,
  error,
}: {
  token: AccessToken;
  editing: boolean;
  error: string | null | undefined;
}) {
  const legacy = token.legacy && token.scopes === null;
  const expiry = describeExpiry(token.expiresAt);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 grow basis-60">
          <p className="truncate text-sm font-medium">{token.name}</p>
          <p className="text-xs text-faint">
            Created <TimeAgo at={token.createdAt} /> ·{" "}
            {token.lastUsedAt ? (
              <>
                last used <TimeAgo at={token.lastUsedAt} />
              </>
            ) : (
              "never used"
            )}{" "}
            ·{" "}
            <span className={expiry === "Expired" ? "text-danger" : undefined}>
              {expiry}
            </span>
          </p>
          <AccessSummary holder={token} />
          {legacy && (
            <p className="mt-1.5 text-xs text-warn">
              Made before tokens had scopes, so it can do everything you can.
              Narrow it to what it needs.
            </p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!editing && (
            <ButtonLink
              variant="quiet"
              to={`?edit=${token.id}`}
              preventScrollReset
            >
              {legacy ? "Narrow this token" : "Edit access"}
            </ButtonLink>
          )}
          <DeleteButton intent="delete-token" id={token.id} />
        </div>
      </div>
      {editing && (
        <Form
          method="post"
          className="mt-4 space-y-5 border-t border-line pt-4"
        >
          <input type="hidden" name="intent" value="update-token" />
          <input type="hidden" name="id" value={token.id} />
          <p className="text-sm text-muted">
            The token stays the same; only what it may do changes, from its next
            request.
          </p>
          <ScopeChecklist initial={token.scopes} />
          <ErrorText>{error}</ErrorText>
          <div className="flex gap-2">
            <Button type="submit">Save access</Button>
            <ButtonLink variant="quiet" to="." preventScrollReset>
              Cancel
            </ButtonLink>
          </div>
        </Form>
      )}
    </li>
  );
}
