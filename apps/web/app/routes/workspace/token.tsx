import { ArrowLeft } from "lucide-react";
import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/token";
import { page } from "../../lib/meta";
import { ErrorText, SubmitButton } from "../../components/ui";
import { TokenForm } from "../../components/token-form";
import { TokenBadges, TokenFacts, TokenMeta } from "../../components/token-list";
import { changesTo, tokenFromForm } from "../../lib/access-tokens";
import { workspaceRepos, workspaceToken } from "../../lib/access-tokens.server";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

// One of the workspace's tokens: what it is, and for owners, changing and
// deleting it. Members see it read-only.

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaderData?.token.name ?? "Access token"} · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const owner = roleIn(viewer, slug) === "owner";
  const [token, repos] = await Promise.all([workspaceToken(viewer, slug, params.id), owner ? workspaceRepos(viewer, slug) : []]);
  return { slug, owner, token, repos };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const form = await request.formData();
  if (form.get("intent") === "delete") {
    const removed = await identity.removeWorkspaceToken(user, slug, params.id);
    if (!removed.ok) return { error: removed.error.message, saved: false };
    throw redirect(`/${slug}/-/tokens`);
  }
  const token = await workspaceToken(user, slug, params.id);
  const input = tokenFromForm(form, { editing: true, workspaceOwned: true, owner: slug });
  if (!input.ok) return { error: input.error, saved: false };
  const change = changesTo(token, input.value);
  if (Object.keys(change).length === 0) return { error: null, saved: true };
  const updated = await identity.updateToken(user, params.id, change, slug);
  return updated.ok ? { error: null, saved: true } : { error: updated.error.message, saved: false };
}

export default function WorkspaceTokenPage({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, owner, token, repos } = loaderData;
  return (
    <section className="max-w-2xl space-y-6">
      <div className="space-y-1.5">
        <Link to={`/${slug}/-/tokens`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
          <ArrowLeft size={13} /> Access tokens
        </Link>
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
          {token.name}
          <TokenBadges token={token} />
        </h2>
        {token.description && <p className="text-sm text-muted">{token.description}</p>}
        <TokenMeta token={token} />
      </div>
      {owner ? (
        <>
          <Form method="post" key={token.id} className="space-y-6">
            <input type="hidden" name="intent" value="save" />
            <TokenForm workspaceOwned slug={slug} repos={repos} editing={token} />
            <ErrorText>{actionData?.error}</ErrorText>
            <div className="flex items-center gap-3">
              <SubmitButton pending="Saving…" match={{ intent: "save" }}>
                Save changes
              </SubmitButton>
              {actionData?.saved && <span className="text-sm text-success">Saved.</span>}
            </div>
          </Form>
          <section className="rounded-xl border border-danger/30 p-4">
            <h3 className="text-sm font-medium">Delete this token</h3>
            <p className="mt-1 text-xs text-muted">Anything still using it stops working at once.</p>
            <Form method="post" className="mt-3">
              <input type="hidden" name="intent" value="delete" />
              <SubmitButton variant="destructive" pending="Deleting…" match={{ intent: "delete" }}>
                Delete token
              </SubmitButton>
            </Form>
          </section>
        </>
      ) : (
        <>
          <TokenFacts token={token} />
          <p className="text-sm text-muted">Only owners can change or delete a workspace's tokens.</p>
        </>
      )}
    </section>
  );
}
