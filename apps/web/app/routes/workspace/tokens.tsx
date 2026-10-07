import { Form } from "react-router";

import { presetScopes } from "@g1t/contracts";

import type { Route } from "./+types/tokens";
import { page } from "../../lib/meta";
import { useAddresses } from "../../lib/addresses";
import {
  CopyLine,
  EmptyState,
  ErrorText,
  Field,
  Input,
  SubmitButton,
  TimeAgo,
} from "../../components/ui";
import { AccessSummary, ExpiryField, ScopeChecklist } from "../../components/token-scopes";
import { identity } from "../../lib/services.server";
import { describeExpiry, expiryTtl, grantFromForm } from "../../lib/token-scopes";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  roleIn,
  unwrap,
} from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Access tokens · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  return {
    slug: params.owner.toLowerCase(),
    role: roleIn(viewer, params.owner),
    tokens: unwrap(await identity.listWorkspaceTokens(params.owner, viewer)),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("action") === "delete") {
    const removed = await identity.removeWorkspaceToken(
      user,
      params.owner,
      String(form.get("id") ?? ""),
    );
    return { token: null, error: removed.ok ? null : removed.error.message };
  }
  const grant = grantFromForm(form);
  if (!grant.ok) return { token: null, error: grant.error };
  const created = await identity.createWorkspaceToken(
    user,
    params.owner,
    String(form.get("label") ?? ""),
    { ...grant.value, ttlSeconds: expiryTtl(form.get("expires")) },
  );
  return created.ok
    ? { token: created.value, error: null }
    : { token: null, error: created.error.message };
}

export default function WorkspaceTokens({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, role, tokens } = loaderData;
  const created = actionData?.token;
  const { site, api } = useAddresses();
  // With git, the token is the password in the clone address, after the scheme.
  const [scheme, rest] = site.split("://");
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0">

        {created && (
          <div className="mt-5 rounded-xl border border-accent/40 bg-surface p-4">
            <p className="text-sm">
              <span className="font-medium">{created.info.name}</span> is ready. Copy
              it now; it will not be shown again.
            </p>
            <div className="mt-3">
              <CopyLine text={created.token} />
            </div>
            <AccessSummary holder={created.info} className="mt-3" />
            <p className="mt-1.5 text-xs text-faint">{describeExpiry(created.info.expiresAt)}</p>
          </div>
        )}

        <div className="mt-5">
          {tokens.length === 0 ? (
            <EmptyState title="No access tokens yet">
              {role === "owner"
                ? "Create one below and give it to whatever needs to act for this workspace."
                : "An owner can create one."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {tokens.map((token) => (
                <li key={token.id} className="flex items-start gap-4 px-4 py-3">
                  <div className="min-w-0 grow">
                    <p className="truncate text-sm font-medium">{token.name}</p>
                    <p className="mt-0.5 text-xs text-faint">
                      Created <TimeAgo at={token.createdAt} />
                      {token.createdBy ? (
                        <>
                          {" "}
                          by <span className="font-mono">{token.createdBy}</span>
                        </>
                      ) : (
                        " by someone who has since left g1t"
                      )}{" "}
                      ·{" "}
                      {token.lastUsedAt ? (
                        <>
                          last used <TimeAgo at={token.lastUsedAt} />
                        </>
                      ) : (
                        "never used"
                      )}{" "}
                      ·{" "}
                      <span className={describeExpiry(token.expiresAt) === "Expired" ? "text-danger" : undefined}>
                        {describeExpiry(token.expiresAt)}
                      </span>
                    </p>
                    <AccessSummary holder={token} />
                    {token.legacy && token.scopes === null && (
                      <p className="mt-1.5 text-xs text-warn">
                        Made before tokens had scopes, so it can do everything a member can here.
                        Replace it with a narrower one.
                      </p>
                    )}
                  </div>
                  {role === "owner" && (
                    <Form method="post">
                      <input type="hidden" name="action" value="delete" />
                      <input type="hidden" name="id" value={token.id} />
                      <SubmitButton variant="quiet" match={{ action: "delete", id: token.id }} pending="Deleting…">
                        Delete
                      </SubmitButton>
                    </Form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {role === "owner" ? (
          // Empty again once the token is made; kept as filled in when it failed.
          <Form method="post" key={created?.info.id ?? ""} className="mt-6 space-y-5 rounded-xl border border-line p-4 sm:p-5">
            <input type="hidden" name="action" value="create" />
            <h2 className="font-medium">New token</h2>
            <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
              <Field label="Name" hint="Name it after what will use it.">
                <Input name="label" required maxLength={100} placeholder="deploy pipeline" />
              </Field>
              <ExpiryField />
            </div>
            <ScopeChecklist initial={presetScopes("ci")} />
            <SubmitButton match={{ action: "create" }} pending="Creating…">
              Create token
            </SubmitButton>
          </Form>
        ) : (
          <p className="mt-4 text-sm text-muted">
            Only owners can create or delete a workspace's tokens.
          </p>
        )}
        <ErrorText>{actionData?.error}</ErrorText>
      </div>

      <aside className="space-y-5 text-sm">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-medium">What a token can do</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-muted">
            <li>
              What its scopes allow, in this workspace only, and never more
              than a member can: push, open and merge pull requests, manage
              issues.
            </li>
            <li>
              It acts as <span className="font-mono text-fg">{slug}</span>, so
              what it does is shown as the workspace's doing.
            </li>
            <li>It keeps working when the person who made it leaves.</li>
            <li>It cannot manage people, tokens or other workspaces.</li>
          </ul>
        </section>
        <section>
          <h3 className="font-medium">Using one</h3>
          <p className="mt-2 text-muted">With git, as the password:</p>
          <div className="mt-2">
            <CopyLine
              prompt
              text={`git clone ${scheme}://${slug}:$G1T_TOKEN@${rest}/${slug}/<repo>.git`}
            />
          </div>
          <p className="mt-4 text-muted">With the API and the MCP server:</p>
          <div className="mt-2">
            <CopyLine
              prompt
              text={`curl -H "Authorization: Bearer $G1T_TOKEN" ${api}/user`}
            />
          </div>
        </section>
      </aside>
    </div>
  );
}
